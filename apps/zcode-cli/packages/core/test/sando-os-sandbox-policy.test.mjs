// Sando --sandbox policy (SANDO-OS-SANDBOX.md, SAN-4472 port 3): the knobs, what a Bash call gets, the one approved
// widening, the js refusal, the implied --confine-to-cwd and the denial note. Run: pnpm test in packages/core.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideOsSandboxForBash,
  isOsSandboxOn,
  osSandboxDenialNote,
  osSandboxSettingFromEnv,
  osSandboxToolRefusal,
  osSandboxWidenFromEnv,
  resetOsSandboxWideningForTest,
} from "../src/tool/os-sandbox-policy.ts";
import { isConfinedToWorkspace } from "../src/tool/path-policy.ts";

const ctx = { workspaceRoot: "/w", workingDirectory: "/w/sub", sessionId: "s1" };

test("SANDO_SANDBOX: unset/off = off, workspace-write/on, read-only; SANDO_SANDBOX_WIDEN: none/one-call/unconfined; others throw", () => {
  assert.equal(osSandboxSettingFromEnv({}), "off");
  assert.equal(osSandboxSettingFromEnv({ SANDO_SANDBOX: "off" }), "off");
  assert.equal(osSandboxSettingFromEnv({ SANDO_SANDBOX: " Workspace-Write " }), "workspace-write");
  assert.equal(osSandboxSettingFromEnv({ SANDO_SANDBOX: "on" }), "workspace-write");
  assert.equal(osSandboxSettingFromEnv({ SANDO_SANDBOX: "read-only" }), "read-only");
  assert.throws(() => osSandboxSettingFromEnv({ SANDO_SANDBOX: "maybe" }), /SANDO_SANDBOX expects/);
  assert.equal(osSandboxWidenFromEnv({}), "none");
  assert.equal(osSandboxWidenFromEnv({ SANDO_SANDBOX_WIDEN: "one-call" }), "one-call");
  assert.equal(osSandboxWidenFromEnv({ SANDO_SANDBOX_WIDEN: "unconfined" }), "unconfined");
  assert.throws(
    () => osSandboxWidenFromEnv({ SANDO_SANDBOX_WIDEN: "always" }),
    /SANDO_SANDBOX_WIDEN expects/,
  );
});

test("a bad SANDO_SANDBOX fails closed: counts as on, and Bash is refused instead of running unconfined", () => {
  assert.equal(isOsSandboxOn({ SANDO_SANDBOX: "maybe" }), true);
  assert.equal(decideOsSandboxForBash({}, ctx, { SANDO_SANDBOX: "maybe" }).kind, "refused");
});

test("Bash: off = unsandboxed; on = confined to the workspace root (not the cwd); unconfined fallback only when widened", () => {
  assert.deepEqual(decideOsSandboxForBash({}, ctx, {}), { kind: "unsandboxed" });
  assert.deepEqual(decideOsSandboxForBash({}, ctx, { SANDO_SANDBOX: "workspace-write" }), {
    kind: "confined",
    os: { mode: "workspace-write", workspaceRoot: "/w" },
  });
  assert.deepEqual(
    decideOsSandboxForBash({}, ctx, {
      SANDO_SANDBOX: "read-only",
      SANDO_SANDBOX_WIDEN: "unconfined",
    }).os,
    { mode: "read-only", workspaceRoot: "/w", allowUnconfined: true },
  );
});

test("one approved widening: refused without one-call; with it, once per session, then refused", () => {
  resetOsSandboxWideningForTest();
  const widen = { dangerouslyDisableSandbox: true };
  const on = { SANDO_SANDBOX: "workspace-write" };
  assert.match(decideOsSandboxForBash(widen, ctx, on).message, /not approved for this run/);
  const once = { ...on, SANDO_SANDBOX_WIDEN: "one-call" };
  assert.equal(decideOsSandboxForBash(widen, ctx, once).kind, "widened");
  assert.match(decideOsSandboxForBash(widen, ctx, once).message, /already used/);
  assert.equal(
    decideOsSandboxForBash(widen, { ...ctx, sessionId: "s2" }, once).kind,
    "widened",
    "per session",
  );
  assert.equal(
    decideOsSandboxForBash({}, ctx, once).kind,
    "confined",
    "normal calls stay confined",
  );
  // unconfined is a host fallback, not a per-call pass
  assert.equal(
    decideOsSandboxForBash(widen, ctx, { ...on, SANDO_SANDBOX_WIDEN: "unconfined" }).kind,
    "refused",
  );
});

test("the js tool is refused while the sandbox is on; the file tools get --confine-to-cwd", () => {
  assert.equal(osSandboxToolRefusal("js", {}), null);
  assert.match(
    osSandboxToolRefusal("js", { SANDO_SANDBOX: "workspace-write" }),
    /outside the OS sandbox/,
  );
  assert.equal(osSandboxToolRefusal("Bash", { SANDO_SANDBOX: "workspace-write" }), null);
  assert.equal(isConfinedToWorkspace({}), false);
  assert.equal(isConfinedToWorkspace({ SANDO_SANDBOX: "read-only" }), true);
});

test("denial note: only on a failed command whose output looks like a sandbox denial", () => {
  const r = (status, exitCode, stderr) => ({
    status,
    exitCode,
    stdout: { text: "" },
    stderr: { text: stderr },
  });
  assert.equal(
    osSandboxDenialNote("workspace-write", r("completed", 0, "Permission denied")),
    undefined,
  );
  assert.equal(osSandboxDenialNote("workspace-write", r("failed", 1, "SyntaxError")), undefined);
  assert.match(
    osSandboxDenialNote("workspace-write", r("failed", 1, "cat: x: Permission denied")),
    /the workspace and \$TMPDIR are writable/,
  );
  assert.match(
    osSandboxDenialNote("read-only", r("failed", 6, "curl: (6) Could not resolve host")),
    /only \$TMPDIR is writable/,
  );
});
