// Sando --sandbox (SANDO-OS-SANDBOX.md): a workspace .zcode/config.json / zcode.json is not read, because its keys
// (mcp.servers, plugins.dirs, network.httpProxy, storage.dir) act in Sando's own process, outside the OS sandbox.
// Run: pnpm test in apps/zcode-cli/packages/adapters.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadProjectConfigs,
  sandboxIgnoresProjectConfig,
} from "../src/config/project-config.adapter.ts";
import { resolveWorkspaceStorageDir } from "../src/config/config-factory.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sando-sbx-projcfg-"));
fs.mkdirSync(path.join(ws, ".zcode"));
const outside = path.join(ws, "..", "elsewhere-storage");
fs.writeFileSync(
  path.join(ws, ".zcode", "config.json"),
  JSON.stringify({
    mcp: { servers: { pwn: { type: "stdio", command: "sh", args: ["-c", "true"] } } },
    network: { httpProxy: "http://127.0.0.1:9" },
    storage: { dir: outside },
  }),
);
fs.writeFileSync(path.join(ws, "zcode.json"), JSON.stringify({ plugins: { dirs: ["/x"] } }));

test("sandboxIgnoresProjectConfig: off / none / unset read the config; any other value (even a bad one) ignores it", () => {
  for (const v of [undefined, "", "off", "none", " OFF "]) assert.equal(sandboxIgnoresProjectConfig({ SANDO_SANDBOX: v }), false, String(v));
  for (const v of ["workspace-write", "read-only", "on", "bogus"]) assert.equal(sandboxIgnoresProjectConfig({ SANDO_SANDBOX: v }), true, v);
});

test("loadProjectConfigs: without --sandbox both workspace files load; with it none does, and each is named in a warning", () => {
  const open = loadProjectConfigs(ws, undefined, {});
  assert.equal(open.files.length, 2);
  assert.deepEqual(open.mcpServerNames, ["pwn"]);
  const shut = loadProjectConfigs(ws, undefined, { SANDO_SANDBOX: "workspace-write" });
  assert.equal(shut.files.length, 0);
  assert.equal(shut.loaded, false);
  assert.deepEqual(shut.mcpServerNames, []);
  assert.deepEqual(shut.hookCandidates, []);
  assert.deepEqual(shut.diagnostics.map((d) => d.code), ["config_project_ignored_by_sandbox", "config_project_ignored_by_sandbox"]);
  assert.deepEqual(shut.diagnostics.map((d) => path.basename(d.filePath)).sort(), ["config.json", "zcode.json"]);
});

test("resolveWorkspaceStorageDir: a workspace storage.dir is not used under --sandbox", () => {
  const saved = process.env.SANDO_SANDBOX;
  try {
    delete process.env.SANDO_SANDBOX;
    assert.equal(resolveWorkspaceStorageDir({ env: {}, workingDirectory: ws }), outside);
    process.env.SANDO_SANDBOX = "workspace-write";
    assert.notEqual(resolveWorkspaceStorageDir({ env: {}, workingDirectory: ws }), outside);
  } finally {
    if (saved === undefined) delete process.env.SANDO_SANDBOX;
    else process.env.SANDO_SANDBOX = saved;
  }
});
