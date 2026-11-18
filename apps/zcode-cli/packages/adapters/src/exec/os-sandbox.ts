// Sando OS sandbox for Bash (SANDO-OS-SANDBOX.md, SAN-4472 port 3). Idea from dsh packages/sandbox (MIT): a runner
// chain (bwrap, then Landlock), each run reports full or partial enforcement, and it fails closed. No code copied; the
// Landlock + seccomp launcher follows the Weight-Space Lab's wsl/sandbox.py, minus its execve block (a shell must exec).
//
// The launcher is Python 3 (ctypes, stdlib only) so the release needs no C toolchain and ships no binary. It runs as
// `python3 -I -S -c <source> --ro P ... --rw P ... -- argv...` and confines itself, then execs argv:
//   - no_new_privs;
//   - Landlock: the filesystem is invisible except the --ro (read/execute) and --rw (read/write) paths; TCP bind/connect
//     denied (ABI >= 4); abstract unix sockets and signals scoped (ABI >= 6). Landlock also scopes ptrace, which keeps
//     /proc/<pid>/environ of processes outside the sandbox unreadable even though /proc is listed;
//   - seccomp: socket() (every family: TCP, UDP, unix, netlink, raw) and the rest of the network calls, ptrace and
//     process_vm_*, namespaces and mounts (unshare, setns, clone with CLONE_NEW*, the old and new mount APIs), bpf,
//     io_uring_* (io_uring would bypass seccomp), keyctl/add_key/request_key, userfaultfd, perf_event_open and
//     file-handle opens fail with EPERM; clone3 gets ENOSYS so libc falls back to clone. socketpair() stays, so pipes
//     between children work. Other architectures and the x32 ABI are killed.
// Exit 125 with "sando-confine: ..." on stderr means the launcher failed and the command did not run.

export const OS_SANDBOX_LAUNCHER_SOURCE = String.raw`import ctypes, os, struct, sys, platform

# Sando OS sandbox launcher (Landlock + seccomp), run as: python3 -I -S -c SRC [--probe] --ro P --rw P ... -- argv...
# Applies, irreversibly, to itself and every child: no_new_privs; Landlock (filesystem invisible except --ro (read/exec)
# and --rw (read/write) paths; TCP bind/connect denied when the ABI has network rules); seccomp (socket(), io_uring,
# ptrace, mount, unshare, setns, bpf fail with EPERM; socketpair stays, so pipes and local IPC between children work).
# Exit 125 + "sando-confine: ..." on stderr = the launcher failed and the command did NOT run.
# --probe: apply everything to a throwaway child and print "landlock-abi=N enforcement=full|partial".

def die(msg):
    sys.stderr.write("sando-confine: " + msg + "\n")
    sys.exit(125)

if platform.machine() != "x86_64":
    die("unsupported architecture " + platform.machine() + " (x86_64 only)")
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long

FS_EXECUTE, FS_WRITE_FILE, FS_READ_FILE, FS_READ_DIR = 1, 2, 4, 8
FS_REFER, FS_TRUNCATE, FS_IOCTL_DEV = 1 << 13, 1 << 14, 1 << 15
NET_BIND_TCP, NET_CONNECT_TCP = 1, 2
SCOPE_ABSTRACT_UNIX, SCOPE_SIGNAL = 1, 2
FILE_RIGHTS = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV

def abi():
    return int(libc.syscall(444, None, ctypes.c_size_t(0), ctypes.c_uint32(1)))

def fs_all(v):
    m = (1 << 13) - 1
    if v >= 2: m |= FS_REFER
    if v >= 3: m |= FS_TRUNCATE
    if v >= 5: m |= FS_IOCTL_DEV
    return m

def landlock(ro, rw):
    v = abi()
    if v < 1:
        die("Landlock is not available (ABI %d)" % v)
    fa = fs_all(v)
    net = (NET_BIND_TCP | NET_CONNECT_TCP) if v >= 4 else 0
    if v >= 6:
        attr = struct.pack("QQQ", fa, net, SCOPE_ABSTRACT_UNIX | SCOPE_SIGNAL)
    elif v >= 4:
        attr = struct.pack("QQ", fa, net)
    else:
        attr = struct.pack("Q", fa)
    buf = ctypes.create_string_buffer(attr, len(attr))
    fd = libc.syscall(444, buf, ctypes.c_size_t(len(attr)), ctypes.c_uint32(0))
    if fd < 0:
        die("landlock_create_ruleset failed (errno %d)" % ctypes.get_errno())
    for paths, rights in ((ro, FS_EXECUTE | FS_READ_FILE | FS_READ_DIR), (rw, fa)):
        for p in paths:
            try:
                pfd = os.open(p, os.O_PATH | os.O_CLOEXEC)
            except OSError:
                continue
            r = rights if os.path.isdir(p) else rights & FILE_RIGHTS
            rule = struct.pack("=Qi", r & fa, pfd)
            b = ctypes.create_string_buffer(rule, len(rule))
            rc = libc.syscall(445, ctypes.c_int(fd), ctypes.c_int(1), b, ctypes.c_uint32(0))
            os.close(pfd)
            if rc != 0:
                die("landlock_add_rule %s failed (errno %d)" % (p, ctypes.get_errno()))
    if libc.syscall(446, ctypes.c_int(fd), ctypes.c_uint32(0)) != 0:
        die("landlock_restrict_self failed (errno %d)" % ctypes.get_errno())
    os.close(fd)
    return v

# Classic BPF, x86_64 only: other architectures and the x32 ABI are killed. EPERM: the network (socket, connect, bind,
# listen, accept, accept4), other processes (ptrace, process_vm_readv/writev, pidfd_getfd), namespaces and mounts
# (unshare, setns, mount, pivot_root, umount2, open_tree, move_mount, fsopen, fsconfig, fsmount, fspick, mount_setattr,
# open_tree_attr), bpf, io_uring_setup/enter/register (io_uring ops bypass seccomp), personality, keyctl, add_key,
# request_key, userfaultfd, perf_event_open, name_to_handle_at, open_by_handle_at; clone() with any CLONE_NEW* flag.
# clone3 gets ENOSYS (its flags sit behind a pointer seccomp cannot read), so libc falls back to clone().
DENY = [41, 42, 49, 50, 43, 288, 101, 310, 311, 438, 272, 308, 165, 155, 166, 428, 429, 430, 431, 432, 433, 442, 467,
        321, 425, 426, 427, 135, 250, 248, 249, 323, 298, 303, 304]
SYS_CLONE, SYS_CLONE3 = 56, 435
CLONE_NEW_FLAGS = 0x7E020000  # NEWNS NEWCGROUP NEWUTS NEWIPC NEWUSER NEWPID NEWNET

def seccomp():
    LD, JEQ, JGE, JSET, RET = 0x20, 0x15, 0x35, 0x45, 0x06
    ALLOW, ERRNO, KILL = 0x7FFF0000, 0x00050000, 0x80000000
    prog = [("LD", 4), ("JEQ", 0xC000003E, None, "kill"), ("LD", 0), ("JGE", 0x40000000, "kill", None)]
    prog += [("JEQ", nr, "eperm", None) for nr in DENY]
    prog += [("JEQ", SYS_CLONE3, "enosys", None), ("JEQ", SYS_CLONE, None, "allow"),
             ("LD", 16), ("JSET", CLONE_NEW_FLAGS, "eperm", None),
             ("label", "allow"), ("RET", ALLOW), ("label", "eperm"), ("RET", ERRNO | 1),
             ("label", "enosys"), ("RET", ERRNO | 38), ("label", "kill"), ("RET", KILL)]
    labels, ins = {}, []
    for op in prog:
        if op[0] == "label":
            labels[op[1]] = len(ins)
        else:
            ins.append(op)
    raw = b""
    for i, op in enumerate(ins):
        if op[0] == "LD":
            raw += struct.pack("HBBI", LD, 0, 0, op[1])
        elif op[0] == "RET":
            raw += struct.pack("HBBI", RET, 0, 0, op[1])
        else:
            code = {"JEQ": JEQ, "JGE": JGE, "JSET": JSET}[op[0]]
            jt = 0 if op[2] is None else labels[op[2]] - i - 1
            jf = 0 if op[3] is None else labels[op[3]] - i - 1
            raw += struct.pack("HBBI", code, jt, jf, op[1])
    filt = ctypes.create_string_buffer(raw, len(raw))
    class Fprog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]
    fp = Fprog(len(ins), ctypes.cast(filt, ctypes.c_void_p))
    if libc.prctl(22, 2, ctypes.byref(fp), 0, 0) != 0:
        die("seccomp failed (errno %d)" % ctypes.get_errno())

def main(argv):
    ro, rw, probe, i = [], [], False, 0
    while i < len(argv) and argv[i] != "--":
        a = argv[i]
        if a == "--probe": probe = True; i += 1; continue
        if a in ("--ro", "--rw") and i + 1 < len(argv):
            (ro if a == "--ro" else rw).append(argv[i + 1]); i += 2; continue
        die("bad argument " + a)
    cmd = argv[i + 1:]
    if not probe and not cmd:
        die("no command")
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        die("no_new_privs failed")
    v = landlock(ro + [os.path.realpath(p) for p in ro], rw + [os.path.realpath(p) for p in rw])
    seccomp()
    level = "full" if v >= 3 else "partial"
    if probe:
        print("landlock-abi=%d enforcement=%s" % (v, level))
        return
    if level == "partial":
        sys.stderr.write("sando-confine: partial enforcement (Landlock ABI %d: writes by truncate() are not covered)\n" % v)
    try:
        os.execvp(cmd[0], cmd)
    except OSError as e:
        die("exec %s: %s" % (cmd[0], e.strerror))

main(sys.argv[1:])
`;

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export type OsSandboxMode = "workspace-write" | "read-only";
export type OsSandboxRunner = "bwrap" | "landlock";
export type OsSandboxEnforcement = "full" | "partial";
export type OsSandboxSelection =
  | {
      runner: OsSandboxRunner;
      enforcement: OsSandboxEnforcement;
      program: string;
      landlockAbi?: number;
    }
  | { runner: "none"; reasons: string[] };

export const OS_SANDBOX_LAUNCHER_FAILURE_EXIT = 125;
/**
 * Force one rung (skips the other): SANDO_SANDBOX_RUNNER=bwrap|landlock. Unset = bwrap, then Landlock. `none` acts as
 * a host without either (tests, and a way to check the fail-closed path on a real host).
 */
export const OS_SANDBOX_RUNNER_ENV = "SANDO_SANDBOX_RUNNER";

/** Test hook: replace the platform, the program lookup or a rung's probe. */
export interface OsSandboxProbes {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  bwrap?: (program: string) => true | string;
  landlock?: (program: string) => { abi: number; enforcement: OsSandboxEnforcement } | string;
}

const PROBE_TIMEOUT_MS = 10_000;
let cachedSelection: OsSandboxSelection | undefined;

/** The runner chain's verdict, probed once per process: bwrap (full), else Landlock (full or partial), else none. */
export function selectOsSandbox(probes?: OsSandboxProbes): OsSandboxSelection {
  if (!probes && cachedSelection) return cachedSelection;
  const selection = walkChain(probes ?? {});
  if (!probes) cachedSelection = selection;
  return selection;
}

export function resetOsSandboxSelectionForTest(): void {
  cachedSelection = undefined;
}

function walkChain(probes: OsSandboxProbes): OsSandboxSelection {
  const platform = probes.platform ?? process.platform;
  if (platform !== "linux") {
    return { runner: "none", reasons: [`the OS sandbox is Linux-only (this is ${platform})`] };
  }
  const env = probes.env ?? process.env;
  const forced = env[OS_SANDBOX_RUNNER_ENV]?.trim().toLowerCase();
  if (forced === "none") return { runner: "none", reasons: [`${OS_SANDBOX_RUNNER_ENV}=none`] };
  if (forced && forced !== "bwrap" && forced !== "landlock") {
    return {
      runner: "none",
      reasons: [`${OS_SANDBOX_RUNNER_ENV} expects bwrap, landlock or none, got "${forced}"`],
    };
  }
  const reasons: string[] = [];
  if (!forced || forced === "bwrap") {
    const program = findProgram("bwrap", env);
    const verdict = !program ? "not installed" : (probes.bwrap ?? probeBwrap)(program);
    if (verdict === true && program) return { runner: "bwrap", enforcement: "full", program };
    reasons.push(`bwrap: ${String(verdict)}`);
  }
  if (!forced || forced === "landlock") {
    const program = findProgram("python3", env);
    const verdict = !program ? "python3 not found" : (probes.landlock ?? probeLandlock)(program);
    if (typeof verdict !== "string" && program) {
      return {
        runner: "landlock",
        enforcement: verdict.enforcement,
        program,
        landlockAbi: verdict.abi,
      };
    }
    reasons.push(`landlock: ${String(verdict)}`);
  }
  return { runner: "none", reasons };
}

/** System directories first, so a planted `python3` or `bwrap` in a workspace on PATH is never picked. */
function findProgram(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = ["/usr/bin", "/bin", "/usr/local/bin", ...(env.PATH ?? "").split(delimiter)];
  for (const dir of dirs) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function firstLine(text: string | undefined): string {
  return (text ?? "").trim().split("\n")[0]?.slice(0, 200) || "failed";
}

function probeBwrap(program: string): true | string {
  const probeTmp = mkdtempSync(join(tmpdir(), "sando-sbx-probe-"));
  try {
    const paths = osSandboxPaths({
      mode: "read-only",
      workspaceRoot: probeTmp,
      privateTmp: probeTmp,
      env: {},
    });
    const result = spawnSync(program, [...bwrapProfileArgs(paths), "--", "/bin/true"], {
      timeout: PROBE_TIMEOUT_MS,
      encoding: "utf8",
    });
    return result.status === 0 ? true : firstLine(result.stderr || result.error?.message);
  } finally {
    rmSync(probeTmp, { recursive: true, force: true });
  }
}

function probeLandlock(
  program: string,
): { abi: number; enforcement: OsSandboxEnforcement } | string {
  const result = spawnSync(program, ["-I", "-S", "-c", OS_SANDBOX_LAUNCHER_SOURCE, "--probe"], {
    timeout: PROBE_TIMEOUT_MS,
    encoding: "utf8",
  });
  const match = /landlock-abi=(\d+) enforcement=(full|partial)/.exec(result.stdout ?? "");
  if (result.status !== 0 || !match) {
    return firstLine(
      (result.stderr || result.error?.message || "").replace(/^sando-confine: /, ""),
    );
  }
  return { abi: Number(match[1]), enforcement: match[2] as OsSandboxEnforcement };
}

// ============================================================
// Policy: what a confined command may read and write
// ============================================================

export interface OsSandboxPaths {
  readOnly: string[];
  readWrite: string[];
}

const SYSTEM_READ_ONLY = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
  "/opt",
  "/sys",
  "/proc",
  "/dev/urandom",
  "/dev/random",
  "/dev/zero",
  "/dev/full",
];
const DEVICES_READ_WRITE = ["/dev/null", "/dev/tty"];
// Toolchains and tool config under $HOME, read-only. Credentials ($HOME/.ssh, .npmrc, .netrc, .config/gh, .aws, the
// vault...) and the rest of $HOME stay invisible.
const HOME_READ_ONLY = [
  ".gitconfig",
  ".config/git",
  ".local/bin",
  ".local/share/mise",
  ".config/mise",
  ".local/state/mise",
  ".cache/mise",
  ".npm-global",
  ".cargo/bin",
  ".rustup",
  ".pyenv",
  ".nvm",
  ".volta",
  ".bun/bin",
  ".deno/bin",
  "go/bin",
  ".local/go",
];

/**
 * workspace-write: the workspace and a private temp dir are writable. read-only: only the private temp dir is.
 * Readable on top: system directories, the toolchains above, every absolute PATH entry (so the commands the
 * model is told about still run) and `extraReadOnly` (Sando's own shell-init snapshot and startup scripts).
 */
export function osSandboxPaths(options: {
  mode: OsSandboxMode;
  workspaceRoot: string;
  privateTmp: string;
  env: NodeJS.ProcessEnv;
  extraReadOnly?: readonly string[];
  home?: string;
}): OsSandboxPaths {
  const home = options.home ?? homedir();
  const pathEntries = (options.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && isAbsolute(dir));
  const readOnly = [
    ...SYSTEM_READ_ONLY,
    ...HOME_READ_ONLY.map((rel) => join(home, rel)),
    ...pathEntries.filter((dir) => dir !== home && dir !== "/"),
    ...(options.extraReadOnly ?? []),
  ];
  const readWrite = [...DEVICES_READ_WRITE, options.privateTmp];
  const git = osSandboxGitDirs(options.workspaceRoot);
  if (options.mode === "workspace-write") {
    readWrite.push(options.workspaceRoot, ...git.readWrite);
    readOnly.push(...git.readOnly);
  } else {
    readOnly.push(options.workspaceRoot, ...git.readOnly, ...git.readWrite);
  }
  return { readOnly: unique(readOnly), readWrite: unique(readWrite) };
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** bwrap: a fresh mount tree with only the policy paths bound, every namespace unshared (no network at all). */
export function bwrapProfileArgs(paths: OsSandboxPaths): string[] {
  const skip = (path: string) => path === "/proc" || path.startsWith("/dev/");
  return [
    "--die-with-parent",
    "--unshare-all",
    "--new-session",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...paths.readOnly.filter((p) => !skip(p)).flatMap((p) => ["--ro-bind-try", realOrSelf(p), p]),
    ...paths.readWrite.filter((p) => !skip(p)).flatMap((p) => ["--bind-try", realOrSelf(p), p]),
  ];
}

/** The confined argv for one command: `file args...` becomes `<runner> <profile> -- file args...`. */
export function osSandboxArgv(
  selection: Extract<OsSandboxSelection, { runner: OsSandboxRunner }>,
  paths: OsSandboxPaths,
  file: string,
  args: readonly string[],
): { file: string; args: string[] } {
  if (selection.runner === "bwrap") {
    return { file: selection.program, args: [...bwrapProfileArgs(paths), "--", file, ...args] };
  }
  return {
    file: selection.program,
    args: [
      "-I",
      "-S",
      "-c",
      OS_SANDBOX_LAUNCHER_SOURCE,
      ...paths.readOnly.flatMap((p) => ["--ro", p]),
      ...paths.readWrite.flatMap((p) => ["--rw", p]),
      "--",
      file,
      ...args,
    ],
  };
}

// Credentials in the environment do not enter the sandbox: with the network closed they could only leak into the
// model's reply, and no sandboxed command can use them anyway. Dropped: names that look like credentials, and any value
// that is a URL with a password in it (DATABASE_URL=postgres://u:pw@…). Caches go to the private temp dir, since
// ~/.cache, ~/.npm and the like are not writable.
const SECRET_ENV_NAME =
  /TOKEN|SECRET|PASSW(OR)?D|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|_KEY$|^KEY$|CREDENTIAL|AUTH|COOKIE|SESSION|WEBHOOK|DSN$|(^|_)PAT$|SSH_ASKPASS/i;
const URL_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

export function osSandboxEnv(env: NodeJS.ProcessEnv, privateTmpDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV_NAME.test(name) || (value !== undefined && URL_WITH_PASSWORD.test(value)))
      continue;
    out[name] = value;
  }
  const cache = join(privateTmpDir, ".cache");
  return {
    ...out,
    TMPDIR: privateTmpDir,
    TMP: privateTmpDir,
    TEMP: privateTmpDir,
    XDG_CACHE_HOME: cache,
    npm_config_cache: join(cache, "npm"),
    PIP_CACHE_DIR: join(cache, "pip"),
    GOCACHE: join(cache, "go"),
    PYTHONPYCACHEPREFIX: join(cache, "pycache"),
  };
}

/** Grant one more writable path to an already confined argv (the Bash output file, which exists only just before spawn). */
export function osSandboxAddWritable(
  runner: OsSandboxRunner,
  args: readonly string[],
  path: string,
): string[] {
  const at = args.indexOf("--");
  if (at < 0) return [...args];
  const extra = runner === "bwrap" ? ["--bind-try", path, path] : ["--rw", path];
  return [...args.slice(0, at), ...extra, ...args.slice(at)];
}

/**
 * A linked git worktree (or a submodule) keeps its git dir outside the workspace: `<ws>/.git` is a file
 * ("gitdir: …"). Its own git dir and the shared objects/, refs/ and logs/ become writable so commits work; the rest
 * of the common dir (config, hooks, info, packed-refs) stays read-only, so a sandboxed command cannot plant hooks or
 * config there. A normal `.git` directory is inside the workspace already.
 */
export function osSandboxGitDirs(workspaceRoot: string): OsSandboxPaths {
  const none = { readOnly: [], readWrite: [] };
  let pointer: string;
  try {
    pointer = readFileSync(join(workspaceRoot, ".git"), "utf8");
  } catch {
    return none;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match?.[1]) return none;
  const gitDir = resolve(workspaceRoot, match[1].trim());
  let commonDir = gitDir;
  try {
    commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  } catch {
    // a submodule's git dir has no commondir file: it is its own common dir
  }
  if (commonDir === gitDir) return { readOnly: [], readWrite: [gitDir] };
  return {
    readOnly: [commonDir],
    readWrite: [
      gitDir,
      join(commonDir, "objects"),
      join(commonDir, "refs"),
      join(commonDir, "logs"),
    ],
  };
}

let privateTmp: string | undefined;

/** One private temp dir per process (TMPDIR inside the sandbox; /tmp itself is not visible), removed at exit. */
export function osSandboxPrivateTmp(): string {
  if (privateTmp && existsSync(privateTmp)) return privateTmp;
  const dir = mkdtempSync(join(tmpdir(), "sando-sbx-"));
  privateTmp = dir;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One line for logs, the run JSON and refusals. */
export function describeOsSandbox(selection: OsSandboxSelection): string {
  if (selection.runner === "none") return `none (${selection.reasons.join("; ")})`;
  const abi = selection.landlockAbi === undefined ? "" : `, Landlock ABI ${selection.landlockAbi}`;
  return `${selection.runner} (${selection.enforcement}${abi})`;
}
