// Sando (ShrineTech): 3D models in the web workbench (2026-11-05, Chuck: "so I can inspect the 3d models").
// Pure helpers, no DOM and no three.js. Spec: SANDO-VIEWER3D.md. Same contract as the Planner's lib/model3dSpec.js, except
// that a src here is a WORKSPACE FILE (read through IFileService.readFileRange over the existing RPC channel), not a Planner URL.
//
//   ```model3d {"src": "fab/torii_70mm.stl", "label": "Torii 70 mm"}    (workspace-relative, ./x, /abs/x or ~/x)
//   ```model3d fab/torii_70mm.stl                                        (a bare src works too)
// Anything with a URL scheme (https:, file:, data:, javascript:) or a leading // is refused: a reply must never make the
// browser fetch from a third party. A .gltf's own resources (its .bin, its textures) are read only from the .gltf's folder.

export type Model3dFormat = "glb" | "gltf" | "stl" | "3mf" | "obj";
export interface Model3dFormatInfo {
  loader: "gltf" | "stl" | "3mf" | "obj";
  mmPerUnit: number;
  zUp: boolean;
}
export interface Model3dSpec {
  src: string;
  label: string;
  file: string;
  format: Model3dFormat;
}
export type Model3dParse = { ok: true; model: Model3dSpec } | { ok: false; error: string };

export const MODEL3D_EXT = /\.(glb|gltf|stl|3mf|obj)$/i;
/** Largest model the viewer reads into the browser (a textured 35 MB GLB is normal; a 1 GB scan is not). */
export const MODEL3D_MAX_BYTES = 256 * 1024 * 1024;

// Print files (STL / 3MF / OBJ from a slicer or CAD) are millimetres and Z-up; glTF is metres and Y-up by spec.
const FORMATS: Record<Model3dFormat, Model3dFormatInfo> = {
  glb: { loader: "gltf", mmPerUnit: 1000, zUp: false },
  gltf: { loader: "gltf", mmPerUnit: 1000, zUp: false },
  stl: { loader: "stl", mmPerUnit: 1, zUp: true },
  "3mf": { loader: "3mf", mmPerUnit: 1, zUp: true },
  obj: { loader: "obj", mmPerUnit: 1, zUp: false },
};

const lang = (l: string | undefined | null): string =>
  String(l || "")
    .trim()
    .toLowerCase();
export const isModel3dLanguage = (l: string | undefined | null): boolean => lang(l) === "model3d";

/** 'glb' | 'gltf' | 'stl' | '3mf' | 'obj' | null (query / fragment / :line suffix ignored). */
export function model3dFormatOf(path: string | null | undefined): Model3dFormat | null {
  const p = String(path ?? "")
    .split(/[?#]/)[0]!
    .replace(/:\d+(?::\d+)?$/, "");
  const m = MODEL3D_EXT.exec(p);
  return m ? (m[1]!.toLowerCase() as Model3dFormat) : null;
}

export const isModel3dPath = (path: string | null | undefined): boolean =>
  model3dFormatOf(path) !== null;
export const model3dFormatInfo = (format: Model3dFormat): Model3dFormatInfo => FORMATS[format];

const hasScheme = (s: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s);
const hasDotDot = (s: string): boolean => s.split(/[\\/]/).includes("..");
export const fileNameOf = (s: string): string =>
  String(s || "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || String(s || "");

/** src check: a file path (relative, absolute or ~/) naming a model; never a URL, never a '..' segment. */
export function checkModel3dSrc(
  src: unknown,
): { ok: true; src: string; format: Model3dFormat } | { ok: false; error: string } {
  const s = String(src ?? "").trim();
  if (!s) return { ok: false, error: "no file" };
  if (hasScheme(s) || s.startsWith("//"))
    return { ok: false, error: "only workspace files open here" };
  if (hasDotDot(s)) return { ok: false, error: "'..' is not allowed in a model path" };
  const format = model3dFormatOf(s);
  if (!format) return { ok: false, error: "not a 3D model (glb, gltf, stl, 3mf, obj)" };
  return { ok: true, src: s, format };
}

/** ```model3d body → { ok, model } | { ok: false, error }. */
export function parseModel3dSpec(body: string): Model3dParse {
  const text = String(body ?? "").trim();
  let raw: unknown;
  if (/^[{"]/.test(text)) {
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: `not valid JSON (${(e as Error).message})` };
    }
  } else raw = { src: text.split("\n")[0]!.trim() };
  if (typeof raw === "string") raw = { src: raw };
  const obj = raw as { src?: unknown; label?: unknown } | null;
  if (!obj || typeof obj !== "object" || !obj.src) return { ok: false, error: 'needs a "src"' };
  const c = checkModel3dSrc(obj.src);
  if (!c.ok) return c;
  const file = fileNameOf(c.src);
  const label =
    typeof obj.label === "string" && obj.label.trim() ? obj.label.trim().slice(0, 200) : file;
  return { ok: true, model: { src: c.src, label, file, format: c.format } };
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Where a .gltf's relative resource lives: in the .gltf's folder or below it. `ref` is the URI as written in the .gltf
 * ('scene.bin', 'textures/a%20b.png'). Returns an absolute path, or null = refuse (a URL, '..', an absolute path).
 */
export function model3dSiblingPath(modelPath: string, ref: string): string | null {
  const r = decodeSafe(String(ref ?? "").trim());
  if (
    !r ||
    hasScheme(r) ||
    r.startsWith("/") ||
    r.startsWith("~") ||
    r.includes("\\") ||
    hasDotDot(r)
  )
    return null;
  const p = String(modelPath ?? "");
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (cut < 0) return null;
  const parts = r.split("/").filter((x) => x && x !== ".");
  return parts.length ? `${p.slice(0, cut + 1)}${parts.join("/")}` : null;
}

/** The relative resources a .gltf names (buffers + images), data: URIs excluded; at most 64. */
export function gltfExternalUris(json: unknown): string[] {
  const j = json as {
    buffers?: Array<{ uri?: unknown }>;
    images?: Array<{ uri?: unknown }>;
  } | null;
  const out = new Set<string>();
  for (const item of [...(j?.buffers ?? []), ...(j?.images ?? [])]) {
    const u = typeof item?.uri === "string" ? item.uri : "";
    if (u && !/^data:/i.test(u)) out.add(u);
  }
  return [...out].slice(0, 64);
}

const fmt1 = (n: number): string =>
  n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);

/** "70.0 × 12.3 × 55.0 mm" (width × depth × height), or metres for very large models. */
export function formatModel3dSize(sizeMm: { x: number; y: number; z: number }): string {
  const v = [sizeMm?.x, sizeMm?.y, sizeMm?.z].map((n) => (Number.isFinite(n) ? Math.abs(n) : 0));
  if (Math.max(...v) >= 10000) return `${v.map((n) => fmt1(n / 1000)).join(" × ")} m`;
  return `${v.map(fmt1).join(" × ")} mm`;
}

export const formatModel3dTriangles = (n: number): string =>
  Math.round(Number(n) || 0).toLocaleString("en-US");

export const formatModel3dBytes = (n: number): string =>
  n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024
      ? `${Math.round(n / 1024)} KB`
      : `${Math.max(0, n | 0)} B`;
