// Sando: --confine-to-cwd (ZCODE_CONFINE_TO_CWD=1) makes the file tools refuse paths outside the workspace.
// Runs the real tool handlers from dist against temp dirs (dist imports @zcode/shared TS source, hence tsx).
// Run: pnpm --filter @zcode/core build && pnpm exec tsx --test test/confine-to-cwd.test.mjs
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { resolveWorkspacePath, isConfinedToWorkspace } = await import("../dist/tool/path-policy.js");
const { writeToolEntry } = await import("../dist/tool/handlers/write.js");
const { readToolEntry } = await import("../dist/tool/handlers/read.js");
const { globToolEntry } = await import("../dist/tool/handlers/glob.js");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-confine-"));
const workspace = path.join(base, "ws");
const outside = path.join(base, "outside");
fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(workspace, "src", "a.txt"), "inside\n");
fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");
fs.symlinkSync(outside, path.join(workspace, "escape"));

const saved = { confine: process.env.ZCODE_CONFINE_TO_CWD, harness: process.env.ZCODE_HARNESS_DIR };
afterEach(() => {
  for (const [k, v] of [
    ["ZCODE_CONFINE_TO_CWD", saved.confine],
    ["ZCODE_HARNESS_DIR", saved.harness],
  ]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
process.on("exit", () => fs.rmSync(base, { recursive: true, force: true }));

const resolveFor = (inputPath, operation = "read") =>
  resolveWorkspacePath({
    inputPath,
    operation,
    workingDirectory: workspace,
    workspaceRoot: workspace,
  });

/** A file-system port that records every call; the confined tool must throw before touching it. */
function recordingPort() {
  const calls = [];
  const fail = (name) => async (req) => {
    calls.push([name, req.path]);
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    throw err;
  };
  return {
    calls,
    port: new Proxy({}, { get: (_t, name) => (typeof name === "string" ? fail(name) : undefined) }),
  };
}

const context = (port) => ({
  toolCallId: "t1",
  workingDirectory: workspace,
  workspaceRoot: workspace,
  fileSystemPort: port,
  readFileState: new Map(),
  abortSignal: new AbortController().signal,
});

test("off by default: outside paths resolve as before", () => {
  delete process.env.ZCODE_CONFINE_TO_CWD;
  assert.equal(isConfinedToWorkspace(), false);
  assert.equal(resolveFor(path.join(outside, "secret.txt")), path.join(outside, "secret.txt"));
});

test("confined: inside paths still resolve (relative, absolute, not-yet-existing)", () => {
  process.env.ZCODE_CONFINE_TO_CWD = "1";
  assert.equal(resolveFor("src/a.txt"), path.join(workspace, "src", "a.txt"));
  assert.equal(
    resolveFor(path.join(workspace, "src", "a.txt")),
    path.join(workspace, "src", "a.txt"),
  );
  assert.equal(resolveFor("new/dir/b.txt", "write"), path.join(workspace, "new", "dir", "b.txt"));
});

test("confined: absolute, ../ and symlink escapes are refused", () => {
  process.env.ZCODE_CONFINE_TO_CWD = "1";
  for (const p of [
    path.join(outside, "secret.txt"),
    "../outside/secret.txt",
    "escape/secret.txt",
    "/etc/passwd",
  ]) {
    assert.throws(() => resolveFor(p), /confined to it \(--confine-to-cwd\)/, p);
  }
  // a sibling whose name only starts with the workspace name is outside too
  fs.mkdirSync(`${workspace}-evil`, { recursive: true });
  assert.throws(() => resolveFor(`${workspace}-evil/x`), /--confine-to-cwd/);
});

test("confined: the --harness dir is allowed", () => {
  process.env.ZCODE_CONFINE_TO_CWD = "1";
  process.env.ZCODE_HARNESS_DIR = outside;
  assert.equal(resolveFor(path.join(outside, "secret.txt")), path.join(outside, "secret.txt"));
});

test("confined: Write refuses an outside path before touching the file system", async () => {
  process.env.ZCODE_CONFINE_TO_CWD = "1";
  const { calls, port } = recordingPort();
  await assert.rejects(
    writeToolEntry.handler(
      { file_path: path.join(outside, "pwned.txt"), content: "x" },
      context(port),
    ),
    /--confine-to-cwd/,
  );
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(outside, "pwned.txt")), false);
});

test("confined: Read refuses outside / symlinked paths before touching the file system", async () => {
  process.env.ZCODE_CONFINE_TO_CWD = "1";
  const { calls, port } = recordingPort();
  await assert.rejects(
    readToolEntry.handler({ file_path: path.join(outside, "secret.txt") }, context(port)),
    /--confine-to-cwd/,
  );
  await assert.rejects(
    readToolEntry.handler({ file_path: "escape/secret.txt" }, context(port)),
    /--confine-to-cwd/,
  );
  assert.deepEqual(calls, []);
});

test("confined: Glob refuses an outside search root", async () => {
  process.env.ZCODE_CONFINE_TO_CWD = "1";
  const { port } = recordingPort();
  await assert.rejects(
    globToolEntry.handler({ pattern: "*.txt", path: outside }, context(port)),
    /--confine-to-cwd/,
  );
});

test("unconfined: Write proceeds to the file system for the same outside path", async () => {
  delete process.env.ZCODE_CONFINE_TO_CWD;
  const { calls, port } = recordingPort();
  // The recording port fails every call, so the handler errors, but only after it reached the file system.
  await writeToolEntry
    .handler({ file_path: path.join(outside, "pwned.txt"), content: "x" }, context(port))
    .catch(() => {});
  assert.ok(calls.length > 0);
});
