// Sando OS sandbox (SANDO-OS-SANDBOX.md, SAN-4472 port 3): the runner chain, the policy paths, the confined argv, and
// the real launcher on this host (skipped without Linux + Landlock). Run: pnpm test in apps/zcode-cli/packages/adapters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bwrapProfileArgs,
  describeOsSandbox,
  OS_SANDBOX_LAUNCHER_SOURCE,
  osSandboxArgv,
  osSandboxPaths,
  selectOsSandbox,
} from "../src/exec/os-sandbox.ts";

const linux = { platform: "linux", env: { PATH: "/usr/bin:/bin" } };

test("chain: bwrap first; Landlock when bwrap is unusable; none (with every reason) when both are", () => {
  const full = { abi: 8, enforcement: "full" };
  assert.equal(
    selectOsSandbox({ ...linux, bwrap: () => true, landlock: () => full }).runner,
    "bwrap",
  );
  const ll = selectOsSandbox({
    ...linux,
    bwrap: () => "setting up uid map: Permission denied",
    landlock: () => full,
  });
  assert.deepEqual(
    { runner: ll.runner, enforcement: ll.enforcement, abi: ll.landlockAbi },
    { runner: "landlock", enforcement: "full", abi: 8 },
  );
  const none = selectOsSandbox({
    ...linux,
    bwrap: () => "setting up uid map: Permission denied",
    landlock: () => "Landlock is not available (ABI -38)",
  });
  assert.equal(none.runner, "none");
  assert.match(
    describeOsSandbox(none),
    /bwrap: setting up uid map.*landlock: Landlock is not available/,
  );
});

test("chain: an old Landlock ABI is partial; other platforms and SANDO_SANDBOX_RUNNER=none have no sandbox", () => {
  const partial = selectOsSandbox({
    ...linux,
    bwrap: () => "no",
    landlock: () => ({ abi: 2, enforcement: "partial" }),
  });
  assert.equal(partial.enforcement, "partial");
  assert.match(describeOsSandbox(partial), /landlock \(partial, Landlock ABI 2\)/);
  assert.match(describeOsSandbox(selectOsSandbox({ platform: "darwin" })), /Linux-only/);
  const forcedNone = selectOsSandbox({
    ...linux,
    env: { ...linux.env, SANDO_SANDBOX_RUNNER: "none" },
    bwrap: () => true,
  });
  assert.equal(forcedNone.runner, "none");
  const forcedLl = selectOsSandbox({
    ...linux,
    env: { ...linux.env, SANDO_SANDBOX_RUNNER: "landlock" },
    bwrap: () => assert.fail("bwrap must not be probed"),
    landlock: () => ({ abi: 8, enforcement: "full" }),
  });
  assert.equal(forcedLl.runner, "landlock");
  assert.equal(
    selectOsSandbox({ ...linux, env: { SANDO_SANDBOX_RUNNER: "chroot" } }).runner,
    "none",
  );
});

test("paths: workspace + private tmp writable; ~/.ssh and the rest of $HOME are not listed; read-only mode", () => {
  const home = "/home/u";
  const env = {
    PATH: `/home/u/.local/share/mise/installs/node/24/bin:/usr/bin:/home/u:/`,
    HOME: home,
  };
  const ww = osSandboxPaths({
    mode: "workspace-write",
    workspaceRoot: "/w",
    privateTmp: "/tmp/sando-sbx-1",
    env,
    home,
  });
  assert.ok(ww.readWrite.includes("/w"));
  assert.ok(ww.readWrite.includes("/tmp/sando-sbx-1"));
  assert.ok(ww.readOnly.includes("/home/u/.local/share/mise/installs/node/24/bin"));
  assert.ok(ww.readOnly.includes("/home/u/.gitconfig"));
  const all = [...ww.readOnly, ...ww.readWrite];
  for (const p of [
    "/home/u",
    "/",
    "/tmp",
    "/home/u/.ssh",
    "/home/u/.npmrc",
    "/home/u/.config",
    "/run",
    "/var",
    "/mnt",
  ]) {
    assert.ok(!all.includes(p), `${p} must not be granted`);
  }
  assert.ok(!all.some((p) => p.startsWith("/home/u/.ssh")));
  const ro = osSandboxPaths({
    mode: "read-only",
    workspaceRoot: "/w",
    privateTmp: "/tmp/sando-sbx-1",
    env,
    home,
  });
  assert.ok(ro.readOnly.includes("/w"));
  assert.ok(!ro.readWrite.includes("/w"));
});

test("argv: Landlock wraps as python3 -I -S -c <launcher> --ro/--rw ... -- cmd; bwrap unshares everything", () => {
  const paths = {
    readOnly: ["/usr", "/proc", "/dev/urandom"],
    readWrite: ["/dev/null", "/w", "/tmp/sbx"],
  };
  const ll = osSandboxArgv(
    { runner: "landlock", enforcement: "full", program: "/usr/bin/python3" },
    paths,
    "/bin/bash",
    ["-c", "ls"],
  );
  assert.equal(ll.file, "/usr/bin/python3");
  assert.deepEqual(ll.args.slice(0, 4), ["-I", "-S", "-c", OS_SANDBOX_LAUNCHER_SOURCE]);
  assert.deepEqual(ll.args.slice(4), [
    "--ro",
    "/usr",
    "--ro",
    "/proc",
    "--ro",
    "/dev/urandom",
    "--rw",
    "/dev/null",
    "--rw",
    "/w",
    "--rw",
    "/tmp/sbx",
    "--",
    "/bin/bash",
    "-c",
    "ls",
  ]);
  const bw = bwrapProfileArgs(paths);
  for (const flag of ["--unshare-all", "--die-with-parent", "--new-session"])
    assert.ok(bw.includes(flag), flag);
  assert.ok(
    bw.indexOf("--tmpfs") < bw.lastIndexOf("--bind-try"),
    "the private tmp is bound after /tmp is replaced",
  );
  assert.ok(!bw.includes("--share-net"));
  assert.ok(!bw.join(" ").includes("--ro-bind / /"), "no blanket bind of the host root");
});

const SKIP_LIVE =
  process.platform === "linux" &&
  Number(
    spawnSync(
      "python3",
      [
        "-c",
        "import ctypes;l=ctypes.CDLL(None);l.syscall.restype=ctypes.c_long;print(l.syscall(444,None,0,1))",
      ],
      {
        encoding: "utf8",
      },
    ).stdout?.trim(),
  ) >= 1
    ? false
    : "needs Linux with Landlock";

function confined(script, { ws, tmp, extraRo = [] }) {
  const args = [
    "-I",
    "-S",
    "-c",
    OS_SANDBOX_LAUNCHER_SOURCE,
    ...["/usr", "/bin", "/lib", "/lib64", "/etc", "/proc", ...extraRo].flatMap((p) => ["--ro", p]),
    ...["/dev/null", ws, tmp].flatMap((p) => ["--rw", p]),
    "--",
    "/bin/sh",
    "-c",
    script,
  ];
  return spawnSync("/usr/bin/python3", args, {
    encoding: "utf8",
    cwd: ws,
    env: { PATH: "/usr/bin:/bin", TMPDIR: tmp },
  });
}

test(
  "launcher, live: probe reports the ABI; writes outside fail, inside work; sockets fail; exit 125 on its own errors",
  { skip: SKIP_LIVE },
  () => {
    const probe = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-c", OS_SANDBOX_LAUNCHER_SOURCE, "--probe"],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /landlock-abi=\d+ enforcement=(full|partial)/);

    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-sbx-unit-"));
    const ws = path.join(base, "ws");
    const tmp = path.join(base, "tmp");
    const out = path.join(base, "out");
    for (const d of [ws, tmp, out]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(out, "secret"), "S");
    try {
      const r = confined(
        `echo in > in.txt && echo t > "$TMPDIR/t" && echo ok; ` +
          `cat ${out}/secret; echo x > ${out}/w; ( : > ${out}/secret ); ` +
          `python3 -c "import socket; socket.socket()" 2>&1 | tail -1; ` +
          `python3 -c "import os; a, b = os.pipe(); import socket; socket.socketpair(); print('pair-ok')"`,
        { ws, tmp },
      );
      assert.match(r.stdout, /^ok$/m, r.stderr);
      assert.ok(fs.existsSync(path.join(ws, "in.txt")));
      assert.match(r.stderr, /secret: Permission denied/);
      assert.ok(!fs.existsSync(path.join(out, "w")));
      assert.equal(
        fs.readFileSync(path.join(out, "secret"), "utf8"),
        "S",
        "truncate outside is blocked",
      );
      assert.match(r.stdout, /PermissionError: \[Errno 1\] Operation not permitted/);
      assert.match(r.stdout, /pair-ok/, "socketpair still works");

      const bad = spawnSync(
        "/usr/bin/python3",
        ["-I", "-S", "-c", OS_SANDBOX_LAUNCHER_SOURCE, "--bogus"],
        { encoding: "utf8" },
      );
      assert.equal(bad.status, 125);
      assert.match(bad.stderr, /^sando-confine: bad argument --bogus/);
      const missing = confined("true", { ws, tmp }); // sanity: a clean command exits 0
      assert.equal(missing.status, 0, missing.stderr);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  },
);
