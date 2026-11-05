// Sando: ```model3d + the PreviewPane 3D viewer (SANDO-VIEWER3D.md). Run: pnpm exec tsx --test packages/ui/test/model3d.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkModel3dSrc,
  formatModel3dBytes,
  formatModel3dSize,
  formatModel3dTriangles,
  gltfExternalUris,
  isModel3dLanguage,
  isModel3dPath,
  model3dFormatInfo,
  model3dFormatOf,
  model3dSiblingPath,
  parseModel3dSpec,
} from "../src/lib/model3dSpec.js";
import { readModel3dFile, type Model3dFileReader } from "../src/lib/model3dFile.js";

test("fence language and model extensions", () => {
  assert.ok(isModel3dLanguage("model3d") && isModel3dLanguage(" Model3D "));
  assert.ok(!isModel3dLanguage("model") && !isModel3dLanguage(null));
  for (const p of ["a.glb", "a.GLTF", "dir/b.stl", "/abs/c.3mf", "d.obj", "e.stl:12", "f.glb?x=1"])
    assert.ok(isModel3dPath(p), p);
  for (const p of ["a.stlx", "a.obj.txt", "a.fbx", "", null])
    assert.ok(!isModel3dPath(p), String(p));
  assert.equal(model3dFormatOf("X/Torii_70mm.STL"), "stl");
});

test("units: print formats are mm and Z-up, glTF is metres", () => {
  assert.deepEqual(model3dFormatInfo("stl"), { loader: "stl", mmPerUnit: 1, zUp: true });
  assert.deepEqual(model3dFormatInfo("3mf"), { loader: "3mf", mmPerUnit: 1, zUp: true });
  assert.equal(model3dFormatInfo("glb").mmPerUnit, 1000);
  assert.equal(model3dFormatInfo("gltf").zUp, false);
  assert.equal(model3dFormatInfo("obj").mmPerUnit, 1);
});

test("src allowlist: workspace paths only, never a URL or ..", () => {
  for (const ok of [
    "fab/torii.stl",
    "./a.glb",
    "/home/u/x.3mf",
    "~/Desktop/y.obj",
    "C:\\models\\z.stl",
  ]) {
    assert.ok(checkModel3dSrc(ok).ok, ok);
  }
  const bad = [
    "https://evil.example/a.glb",
    "http://127.0.0.1/a.stl",
    "file:///etc/a.stl",
    "data:model/gltf+json,{}.gltf",
    "javascript:alert(1)//.glb",
    "//evil/a.glb",
    "../outside.stl",
    "a/../../b.stl",
    "",
    "notes.txt",
  ];
  for (const b of bad) assert.equal(checkModel3dSrc(b).ok, false, b);
});

test("```model3d bodies", () => {
  const j = parseModel3dSpec('{"src":"fab/torii_70mm.stl","label":"Torii 70 mm"}');
  assert.ok(
    j.ok &&
      j.model.label === "Torii 70 mm" &&
      j.model.file === "torii_70mm.stl" &&
      j.model.format === "stl",
  );
  const bare = parseModel3dSpec("Printer/torii_ai.glb\n");
  assert.ok(bare.ok && bare.model.label === "torii_ai.glb" && bare.model.format === "glb");
  const str = parseModel3dSpec('"box.3mf"');
  assert.ok(str.ok && str.model.src === "box.3mf");
  assert.equal(parseModel3dSpec("{bad").ok, false);
  assert.equal(parseModel3dSpec('{"label":"x"}').ok, false);
  assert.equal(parseModel3dSpec('{"src":"https://cdn.example/x.glb"}').ok, false);
  const long = parseModel3dSpec(JSON.stringify({ src: "a.obj", label: "x".repeat(500) }));
  assert.ok(long.ok && long.model.label.length === 200);
});

test(".gltf siblings stay in the model's folder", () => {
  const m = "/ws/models/robot/robot.gltf";
  assert.equal(model3dSiblingPath(m, "robot.bin"), "/ws/models/robot/robot.bin");
  assert.equal(
    model3dSiblingPath(m, "textures/base%20color.png"),
    "/ws/models/robot/textures/base color.png",
  );
  assert.equal(model3dSiblingPath(m, "./tex/a.png"), "/ws/models/robot/tex/a.png");
  for (const bad of [
    "../secret.bin",
    "tex/../../x.png",
    "%2e%2e/x.bin",
    "/etc/passwd",
    "~/x.bin",
    "https://evil/x.bin",
    "file:///x.bin",
    "a\\b.bin",
    "",
    "//evil/x.bin",
  ]) {
    assert.equal(model3dSiblingPath(m, bad), null, bad);
  }
  assert.deepEqual(
    gltfExternalUris({
      buffers: [{ uri: "a.bin" }, { uri: "data:application/octet-stream;base64,AA==" }],
      images: [{ uri: "t.png" }, { bufferView: 1 }, { uri: "a.bin" }],
    }),
    ["a.bin", "t.png"],
  );
  assert.deepEqual(gltfExternalUris(null), []);
});

test("readouts", () => {
  assert.equal(formatModel3dSize({ x: 70, y: 12.34, z: 55 }), "70.0 × 12.3 × 55.0 mm");
  assert.equal(formatModel3dSize({ x: 120, y: 3.456, z: 0.5 }), "120 × 3.46 × 0.50 mm");
  assert.equal(formatModel3dSize({ x: 12000, y: 500, z: 3000 }), "12.0 × 0.50 × 3.00 m");
  assert.equal(formatModel3dTriangles(1234567.4), "1,234,567");
  assert.equal(formatModel3dBytes(35 * 1048576), "35.0 MB");
  assert.equal(formatModel3dBytes(2048), "2 KB");
});

function fakeReader(
  bytes: Uint8Array,
  { clamp = 1024 * 1024, size = true }: { clamp?: number; size?: boolean } = {},
) {
  const calls: Array<[number, number]> = [];
  const reader: Model3dFileReader = {
    async stat() {
      return size ? { type: "file", size: bytes.byteLength } : { type: "file" };
    },
    async readFileRange({ offset, length }) {
      calls.push([offset, length]);
      return bytes.slice(offset, offset + Math.min(length, clamp));
    },
  };
  return { reader, calls };
}

test("the model is read whole through readFileRange, in parallel windows", async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024 + 123).map((_, i) => i % 251);
  const { reader, calls } = fakeReader(bytes);
  const seen: number[] = [];
  const buf = await readModel3dFile(reader, "/ws/a.glb", { onProgress: (r) => seen.push(r) });
  assert.deepEqual(new Uint8Array(buf), bytes);
  assert.equal(calls.length, 4);
  assert.equal(seen.at(-1), bytes.byteLength);
});

test("short chunks (an older or remote service) are topped up; no size = sequential", async () => {
  const bytes = new Uint8Array(1500 * 1024).map((_, i) => (i * 7) % 256);
  const clamped = fakeReader(bytes, { clamp: 256 * 1024 });
  assert.deepEqual(new Uint8Array(await readModel3dFile(clamped.reader, "/ws/a.stl")), bytes);
  const noSize = fakeReader(bytes, { size: false });
  assert.deepEqual(new Uint8Array(await readModel3dFile(noSize.reader, "/ws/a.stl")), bytes);
});

test("too large, empty, directory and abort are refused before reading everything", async () => {
  const big = fakeReader(new Uint8Array(10));
  await assert.rejects(readModel3dFile(big.reader, "/a.stl", { maxBytes: 5 }), /too large/);
  assert.equal(big.calls.length, 0);
  await assert.rejects(readModel3dFile(fakeReader(new Uint8Array(0)).reader, "/a.stl"), /empty/);
  const dir: Model3dFileReader = {
    async stat() {
      return { type: "directory" };
    },
    async readFileRange() {
      return new Uint8Array();
    },
  };
  await assert.rejects(readModel3dFile(dir, "/a.stl"), /not a file/);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    readModel3dFile(fakeReader(new Uint8Array(10)).reader, "/a.stl", { signal: ac.signal }),
    /aborted/,
  );
});
