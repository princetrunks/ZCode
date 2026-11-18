# Sando OS sandbox for Bash (spec)

Port 3 from the DeepSeek Harness study (`docs/dsh-study-2026-11-17.md` §3, branch `fleet/dsh-study-20261117`), Planner
SAN-4472. Idea from dsh `packages/sandbox` (MIT): a runner chain (bwrap, then Landlock), each run reports `full` or
`partial` enforcement, it fails closed, and one approved widening. No dsh code copied. The Landlock + seccomp launcher
follows the Weight-Space Lab's `wsl/sandbox.py`, minus its `execve` block (a shell has to exec).

## 1. Why

`--deny-commands` and `--confine-to-cwd` check what the model *asks* for. Neither sees what a command does once it
runs: `python3 -c "open('/home/…/x','w')"`, `node -e`, a script the model wrote, or `env | grep TOKEN`. The OS
sandbox confines the process itself, so those are blocked whatever the model writes.

## 2. Behaviour

```sh
sando -p "…" --sandbox workspace-write        # Bash runs confined (SANDO_SANDBOX=workspace-write)
sando -p "…" --sandbox read-only              # the workspace is readable, only $TMPDIR is writable
sando -p "…" --sandbox workspace-write --sandbox-widen one-call    # the one approved widening, see below
sando -p "…" --sandbox workspace-write --sandbox-widen unconfined  # run even where no sandbox works
# unset / off = upstream behaviour (no sandbox). Any other value of either flag is a startup error.
```

**What a confined Bash command can do** (`adapters/src/exec/os-sandbox.ts` `osSandboxPaths`):
- **Write:** the workspace root (`workspace-write`), a private `$TMPDIR` (one per Sando process, removed at exit),
  `/dev/null`, `/dev/tty`.
- **Read and execute:**
  - `/usr /bin /sbin /lib* /etc /opt /sys /proc`, `/dev/{urandom,random,zero,full}`;
  - toolchains under `$HOME`: `.gitconfig`, `.config/git`, mise (`.local/share/mise`, `.config/mise`,
    `.local/state/mise`, `.cache/mise`), `.local/bin`, `.npm-global`, `.cargo/bin`, `.rustup`, `.pyenv`, `.nvm`,
    `.volta`, `.bun/bin`, `.deno/bin`, `go/bin`;
  - every absolute `PATH` entry, so the commands the model is told about still run;
  - Sando's own shell-init snapshot and startup scripts.
- **Everything else is invisible:**
  - the rest of `$HOME` (`.ssh`, `.npmrc`, `.config/*`, the vault, other repos);
  - `/tmp`, `/run` (the docker socket, ssh-agent, dbus), `/mnt`, `/var`;
  - `/` itself is not listable.
- **Network: none.** seccomp makes `socket()` fail for every family (TCP, UDP, unix, netlink, raw), and also `connect`,
  `bind`, `listen` and `accept`. Landlock denies TCP bind/connect too (ABI ≥ 4). `socketpair()` stays, so pipes and
  child processes work. Unix sockets are blocked on purpose: the forge user is in the `docker` group, so a
  `connect()` to `/var/run/docker.sock` would be root.
- **Also denied (EPERM):**
  - `ptrace` and `process_vm_*`; Landlock also scopes ptrace, which keeps `/proc/<pid>/environ` of processes outside
    the sandbox unreadable;
  - `unshare`, `setns`, `mount`, `pivot_root`, `umount2`, `bpf`, `pidfd_getfd`, `personality`;
  - `io_uring_*` (io_uring would bypass seccomp);
  - other architectures and the x32 ABI are killed.
- **Env:** variables whose names look like credentials (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `ACCESS_KEY`,
  `PRIVATE_KEY`, `CREDENTIAL`, `AUTH`, so also `SSH_AUTH_SOCK`) are dropped. `TMPDIR`, `TMP` and `TEMP` point at the
  private temp dir.

**The rest of the run under `--sandbox`:**
- The file tools (Read/Write/Edit/Grep/Glob) get `--confine-to-cwd`: they run in Sando's own process, outside the OS
  sandbox.
- The `js` (node REPL) tool is refused for the same reason.
- A failed command whose output looks like a denial gets one note line:
  `[Sando sandbox (workspace-write): the workspace and $TMPDIR are writable; the network, /tmp and ~ (except
  toolchains) are blocked. A denial here is the sandbox, not a bug: do not retry variants of it.]`

**Runner chain** (probed once per process, `selectOsSandbox`):

| rung | when | enforcement |
|---|---|---|
| bwrap | `bwrap` runs the profile (`--unshare-all --die-with-parent --new-session`, only the policy paths bound) | full |
| Landlock + seccomp | `python3` (system dirs first) runs the launcher's `--probe`: Landlock ABI ≥ 3 | full |
| Landlock + seccomp | Landlock ABI 1–2: `truncate()` on a file outside is not covered | partial |
| none | neither works, not Linux, or `SANDO_SANDBOX_RUNNER=none` | fails closed |

- `SANDO_SANDBOX_RUNNER=bwrap|landlock` forces one rung; `none` simulates a host with neither.
- **On Phoenix Forge:**
  - bwrap fails (`setting up uid map: Permission denied`, `kernel.apparmor_restrict_unprivileged_userns=1`);
  - so the chain picks Landlock (ABI 8, kernel 7.0): `landlock (full, Landlock ABI 8)`;
  - it also works inside the dsh-box Docker image (same ABI).

**Fails closed:**
- With `--sandbox` on and no usable rung, Sando refuses to start, before any model request:
  `--sandbox workspace-write: no usable OS sandbox on this host: none (bwrap: …; landlock: …). Sando refuses to run
  unconfined. --sandbox-widen unconfined (SANDO_SANDBOX_WIDEN=unconfined) runs without one.`
- At each Bash call the adapter checks again (`spawn_error`, "The command did not run").
- A bad `SANDO_SANDBOX` value counts as on, so Bash is refused rather than run unconfined.
- If the launcher itself fails, it exits 125 with `sando-confine: …`, and the command did not run.

**The one approved widening** (`--sandbox-widen one-call`):
- The first Bash call per session that sets `dangerouslyDisableSandbox: true` runs unconfined. Its result says so.
- Every other such call is refused.
- Without the flag, every such call is refused.
- Approval is the flag at launch. Headless runs have nobody to ask, and an interactive "ask the user" prompt is not
  built (see 5).

**Report:** the headless JSON (`--json`, and the stream-json `result` line) carries
`"sandbox": {"mode","runner","enforcement","landlockAbi","widen"}` when the sandbox is on, e.g.
`{"mode":"workspace-write","runner":"landlock","enforcement":"full","landlockAbi":8,"widen":"none"}`.

**Cost:** about 17 ms per Bash call (python3 start + 47 rules). A bare `bash -c true` takes 1.6 ms, a sandboxed one
18.9 ms (30 runs each on the forge). The launcher is passed as `python3 -I -S -c <source>`, about 6.4 kB of argv. No
file is written, so nothing can swap it.

**Code:**
- `adapters/src/exec/os-sandbox.ts`: launcher, chain, policy, argv, env.
- `adapters/src/exec/node-execution-adapter-process.ts` (`prepareChildSpawn`): wraps the command; the cwd-capture
  file goes to the private temp dir.
- `contracts` `ExecutionSandboxPolicy.os`.
- `core/src/tool/os-sandbox-policy.ts`: knobs, per-call decision, widening, `js` refusal, note.
- `core/src/tool/handlers/bash.ts`, `core/src/tool/executor/permission-flow.ts`, `core/src/tool/path-policy.ts`.
- `bootstrap/src/app/runtime-config.ts`: startup probe.
- `cli/src/harness-flags.ts`, `cli/src/arguments.ts`, `cli/src/sandbox-report.ts`.

## 3. Tests

- `cli/test/sando-os-sandbox.e2e.test.mjs` (10). Each runs the built CLI headless with a scripted model:
  - **Blocked** (8 attacks): `cat ~/.ssh/id_ed25519`; `cat` of a file outside; writes outside by `echo >`,
    `python3 -c` and `node -e`; TCP connect to a listener the test runs (python and node); a unix-socket connect to a
    socket the test listens on. The listeners count zero connections, and nothing appears outside.
  - **Control:** without `--sandbox` the same commands all get through.
  - **Env:** `HF_TOKEN` / `CIVITAI_API_KEY` are empty inside; other vars pass.
  - **Works:** shell build steps, `node --test` (pass 1 / fail 0), `git init/add/commit`, python `tempfile` in
    `$TMPDIR`, and `cd dist` carrying over to the next call (the cwd capture).
  - **read-only mode:** the workspace is readable but not writable.
  - **File tools:** `Read ~/.ssh/id_ed25519` is refused.
  - **Fail closed:** no usable sandbox (`SANDO_SANDBOX_RUNNER=none`) refuses before any model request; with
    `--sandbox-widen unconfined` the run goes ahead and the JSON says `runner: none`.
  - **Widening:** refused without `one-call`; with it, one call out and the second refused.
  - **Bad values:** bad flag values fail before any model request.
- `adapters/test/sando-os-sandbox.test.mjs` (6):
  - chain order and reasons, partial, other platforms, the forced runner;
  - policy paths: `~/.ssh`, `~`, `/`, `/tmp`, `/run`, `/mnt` are never granted;
  - Landlock and bwrap argv;
  - the env filter;
  - the real launcher on this host: probe; writes, truncate and read outside fail; inside works; `socket()` is EPERM,
    `socketpair()` works; exit 125 on its own errors.
- `core/test/sando-os-sandbox-policy.test.mjs` (6): knobs; a bad value fails closed; per-call decisions; widening once
  per session; the `js` refusal and the implied `--confine-to-cwd`; the denial note.

## 4. Red team and A/B

See `FLEET-REPORT.md` (2026-11-18 port 3 entry). The kit is `~/apps/fleet/work/sando-os-sandbox/`: `run.sh`,
`queue.sh`, `sbxstats.py`, `redteam.sh`, `replay.mjs`, `hostcheck.mjs`. Raw runs are in
`/mnt/storage/scratch/sando-os-sandbox-1118/`.

## 5. Not covered / known limits

- **No sockets at all, loopback included.**
  - A test suite that starts a local HTTP server, or a dev server, fails inside the sandbox.
  - Landlock rules are per port, not per address, and seccomp cannot read the address. "Loopback only" needs a
    network namespace (bwrap), which AppArmor blocks here.
- **`.git` in the workspace is writable.**
  - A command can plant `.git/hooks/*` or `core.hooksPath` / `core.fsmonitor` in `.git/config`. They run later,
    unconfined, when someone uses git on that repo outside the sandbox.
  - Landlock cannot subtract a subdirectory from an allowed tree. A git worktree's shared `.git` lives outside the
    workspace, so `git commit` in a worktree fails (its index and objects are not writable).
- **Not inside the sandbox:**
  - what runs in Sando's own process: WebFetch/WebSearch (network), MCP servers, hooks and the provider connection;
  - processes Sando starts itself: the shell-init snapshot (the user's login shell, as upstream).
  - The sandbox is for Bash. The file tools are covered by `--confine-to-cwd` instead.
- **Readable by design:**
  - `/proc/<pid>/cmdline` of other processes (but not their `environ`);
  - `/etc`;
  - every `PATH` directory.
- **`/tmp` is not shared:** a tool that hard-codes `/tmp` instead of `$TMPDIR` fails. The npm/pnpm caches under `~` are
  not readable, so `npx` of a package that is not installed in the workspace fails (it would need the network anyway).
- **Not verified:**
  - **bwrap:** the rung is built and its argv is unit-tested, but it cannot run on this host.
  - **The launcher is x86_64 only.** Elsewhere the probe fails and Sando fails closed.
  - **Interactive approval for the widening** (ask the user in the TUI/web) is not built; the flag is the approval.
- **Session resume:** the one-call widening is counted per session id in memory, so a new process gets a new one.
