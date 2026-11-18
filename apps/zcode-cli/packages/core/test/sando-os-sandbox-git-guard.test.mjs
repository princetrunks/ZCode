// Sando --sandbox git guard (SANDO-OS-SANDBOX.md): program-running git config a sandboxed command adds is undone, new
// hooks are disabled, plain config changes stay, and the workspace may not contain $HOME. Run: pnpm test in packages/core.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyOsSandboxGitHardening,
  enforceGitGuard,
  programConfigEntries,
  readGitGuardState,
} from "../src/tool/os-sandbox-git-guard.ts";
import { decideOsSandboxForBash } from "../src/tool/os-sandbox-policy.ts";

const CONFIG = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n[user]\n\temail = a@b\n";

function repo() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sando-git-guard-"));
  fs.mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".git", "config"), CONFIG);
  fs.writeFileSync(path.join(ws, ".git", "hooks", "pre-commit.sample"), "#!/bin/sh\n");
  return ws;
}

test("programConfigEntries: finds program-running keys in every header form, ignores plain ones", () => {
  const text = [
    "[core]",
    "\tfsmonitor = /tmp/x.sh",
    "\teditor=vim",
    "\tbare = false",
    '[filter "lfs"]',
    "\tclean = git-lfs clean -- %f",
    "[diff.png]",
    "\ttextconv = exiftool",
    "[alias]",
    "\tst = !sh -c id",
    '[includeIf "gitdir:/w/"]',
    "\tpath = ../evil.cfg",
    "[user]",
    "\temail = a@b",
    '[remote "origin"]',
    "\turl = git@x:y",
    "\tuploadpack = /tmp/up",
    "[core] hooksPath = /tmp/h",
  ].join("\n");
  assert.deepEqual(
    programConfigEntries(text).map((e) => e.split("=")[0]),
    [
      "core.fsmonitor",
      "core.editor",
      "filter.lfs.clean",
      "diff.png.textconv",
      "alias.st",
      "includeif.gitdir:/w/.path",
      "remote.origin.uploadpack",
      "core.hookspath",
    ],
  );
});

test("guard: an added fsmonitor is undone, a plain change stays, a new hook is disabled", () => {
  const ws = repo();
  const config = path.join(ws, ".git", "config");
  const before = readGitGuardState(ws);
  fs.writeFileSync(config, CONFIG + '[remote "origin"]\n\turl = /x\n');
  let r = enforceGitGuard(ws, before);
  assert.deepEqual(r.notes, [], "a plain change is left alone");
  assert.match(fs.readFileSync(config, "utf8"), /remote "origin"/);
  fs.writeFileSync(config, fs.readFileSync(config, "utf8") + "[core]\n\tfsmonitor = ./pwn.sh\n");
  fs.writeFileSync(path.join(ws, ".git", "hooks", "post-checkout"), "#!/bin/sh\nid\n", {
    mode: 0o755,
  });
  r = enforceGitGuard(ws, r.state);
  assert.equal(r.notes.length, 2, r.notes.join("\n"));
  assert.match(r.notes[0], /restored .*config \(it gained core\.fsmonitor\)/);
  assert.doesNotMatch(fs.readFileSync(config, "utf8"), /fsmonitor/);
  assert.match(
    fs.readFileSync(config, "utf8"),
    /remote "origin"/,
    "restored to the last known good state",
  );
  assert.ok(!fs.existsSync(path.join(ws, ".git", "hooks", "post-checkout")));
  assert.ok(fs.existsSync(path.join(ws, ".git", "hooks", "post-checkout.sando-blocked")));
  assert.deepEqual(enforceGitGuard(ws, r.state).notes, [], "nothing left to undo");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("guard: a repo created inside the sandbox with a hooksPath gets its config moved aside", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sando-git-guard-"));
  const before = readGitGuardState(ws);
  assert.equal(before, undefined);
  fs.mkdirSync(path.join(ws, ".git"));
  fs.writeFileSync(path.join(ws, ".git", "config"), CONFIG + "[core]\n\thooksPath = /tmp/h\n");
  const r = enforceGitGuard(ws, before);
  assert.equal(r.notes.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(ws, ".git", "config"), "utf8"), /hooksPath/);
  assert.ok(fs.existsSync(path.join(ws, ".git", "config.sando-blocked")));
  fs.rmSync(ws, { recursive: true, force: true });
});

test("hardening env: core.fsmonitor=false appended to GIT_CONFIG_COUNT once, existing entries kept", () => {
  const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" };
  applyOsSandboxGitHardening(env);
  applyOsSandboxGitHardening(env);
  assert.equal(env.GIT_CONFIG_COUNT, "2");
  assert.equal(env.GIT_CONFIG_KEY_0, "a.b");
  assert.equal(env.GIT_CONFIG_KEY_1, "core.fsmonitor");
  assert.equal(env.GIT_CONFIG_VALUE_1, "false");
});

test("a workspace that is /, $HOME or a parent of $HOME is refused", () => {
  const env = { SANDO_SANDBOX: "workspace-write", HOME: "/home/u" };
  for (const root of ["/", "/home/u", "/home", "/home/u/"]) {
    const d = decideOsSandboxForBash({}, { workspaceRoot: root, workingDirectory: root }, env);
    assert.equal(d.kind, "refused", root);
    assert.match(d.message, /contains the home directory/);
  }
  assert.equal(
    decideOsSandboxForBash(
      {},
      { workspaceRoot: "/home/u/repo", workingDirectory: "/home/u/repo" },
      env,
    ).kind,
    "confined",
  );
});
