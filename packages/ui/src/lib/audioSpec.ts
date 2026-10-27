// Sando (ShrineTech): ```audio blocks — same contract as the Planner (Project_Planner client/src/lib/audioSpec.js, 2026-10-27).
//   ```audio {"src": "filler_lora_ab/01_a.wav", "label": "Take 1"}   (or {"tracks": [{src, label}, …]}, or a bare src)
// Files are served by the PLANNER (GET /api/lily/media/shared, owner only, allowlisted folders, Range/206), so the
// player points at the Planner on the same site as this workbench: projects.shrinetech.io next to sando.shrinetech.io,
// or the same LAN / Tailscale host on :4001. The Planner's pp_media cookie (same-site) authenticates the request;
// a browser that is not logged in to the Planner gets a "could not load" line. Outside URLs are refused.
// ```abtest is not drawn here (Planner Chat / Lily only): it shows as source.

export interface AudioTrack { src: string; url: string; label: string }
export type AudioParse = { ok: true; tracks: AudioTrack[]; title: string } | { ok: false; error: string };

export const isAudioLanguage = (lang: string | undefined | null): boolean => String(lang || "").trim().toLowerCase() === "audio";

const PLANNER_MEDIA = /^\/api\/(?:lily\/media|attachments\/file)\//;

/** Where the Planner lives, seen from this page. */
export function plannerOrigin(loc: { protocol: string; hostname: string } | null =
  typeof location !== "undefined" ? location : null): string {
  if (!loc || /(^|\.)shrinetech\.io$/i.test(loc.hostname)) return "https://projects.shrinetech.io";
  return `${loc.protocol}//${loc.hostname}:4001`;
}

export function audioUrl(src: unknown, origin = plannerOrigin()): { ok: true; url: string } | { ok: false; error: string } {
  const s = String(src ?? "").trim();
  if (!s) return { ok: false, error: "no file" };
  if (PLANNER_MEDIA.test(s) && !s.includes("..")) return { ok: true, url: origin + s };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) return { ok: false, error: "only Planner files play here" };
  return { ok: true, url: `${origin}/api/lily/media/shared?p=${encodeURIComponent(s)}` };
}

const fileName = (s: string): string => s.split(/[\\/]/).filter(Boolean).pop() || s;

export function parseAudioSpec(src: string, origin = plannerOrigin()): AudioParse {
  const text = String(src || "").trim();
  let raw: any;
  if (/^[[{"]/.test(text)) {
    try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: `not valid JSON (${(e as Error).message})` }; }
  } else raw = { src: text };
  if (typeof raw === "string") raw = { src: raw };
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.tracks) ? raw.tracks : [raw];
  const tracks: AudioTrack[] = [];
  const errors: string[] = [];
  for (const t of list.slice(0, 12)) {
    const item = typeof t === "string" ? { src: t } : t;
    if (!item || typeof item !== "object" || !item.src) continue;
    const u = audioUrl(item.src, origin);
    if (!u.ok) { errors.push(`${fileName(String(item.src))}: ${u.error}`); continue; }
    tracks.push({ src: String(item.src), url: u.url, label: String(item.label || fileName(String(item.src))) });
  }
  if (!tracks.length) return { ok: false, error: errors[0] || 'needs a "src"' };
  return { ok: true, tracks, title: Array.isArray(raw) ? "" : String(raw.title || "") };
}
