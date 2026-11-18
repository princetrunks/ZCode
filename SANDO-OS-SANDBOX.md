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
- **Write:**
  - the workspace root (`workspace-write`);
  - a private `$TMPDIR` (one per Sando process, removed at exit);
  - the command's own output file, so `> /dev/stderr` works;
  - `/dev/null`, `/dev/tty`;
  - in a linked git worktree (or a submodule), its own git dir plus the shared `objects/`, `refs/` and `logs/`, so
    `git commit` works. The common dir's `config`, `hooks`, `info` and `packed-refs` stay read-only.
- **Read and execute:**
  - `/usr /bin /sbin /lib* /etc /opt /sys /proc`, `/dev/{urandom,random,zero,full}`;
  - toolchains under `$HOME`: `.gitconfig`, `.config/git`, mise (`.local/share/mise`, `.config/mise`,
    `.local/state/mise`, `.cache/mise`), `.local/bin`, `.npm-global`, `.cargo/bin`, `.rustup`, `.pyenv`, `.nvm`,
    `.volta`, `.bun/bin`, `.deno/bin`, `go/bin`;
  - every absolute `PATH` entry, so the commands the model is told about still run;
  - Sando's own shell-init snapshot (that one file) and startup scripts.
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
  - namespaces: `unshare`, `setns`, and `clone` with any `CLONE_NEW*` flag. `clone3` gets ENOSYS (its flags sit
    behind a pointer), so libc falls back to `clone`;
  - mounts: `mount`, `pivot_root`, `umount2`, and the new mount API (`open_tree`, `move_mount`, `fsopen`,
    `fsconfig`, `fsmount`, `fspick`, `mount_setattr`, `open_tree_attr`);
  - `bpf`, `io_uring_*` (io_uring would bypass seccomp), `keyctl`, `add_key`, `request_key`, `userfaultfd`,
    `perf_event_open`, `name_to_handle_at`, `open_by_handle_at`, `pidfd_getfd`, `personality`;
  - other architectures and the x32 ABI are killed.
  - The filter is built from labels, so no jump offset is hand-counted.
- **Env:**
  - Dropped: names that look like credentials (`TOKEN`, `SECRET`, `PASSWORD`/`PASSWD`, `PASSPHRASE`, `API_KEY`,
    `ACCESS_KEY`, `PRIVATE_KEY`, `*_KEY`, `CREDENTIAL`, `AUTH` (so `SSH_AUTH_SOCK`), `COOKIE`, `SESSION`, `WEBHOOK`,
    `*DSN`, `*_PAT`), and any value that is a URL with a password in it (`DATABASE_URL=postgres://u:pw@…`).
  - `TMPDIR`, `TMP` and `TEMP` point at the private temp dir, and so do the caches (`XDG_CACHE_HOME`,
    `npm_config_cache`, `PIP_CACHE_DIR`, `GOCACHE`, `PYTHONPYCACHEPREFIX`).
- **The workspace must not contain `$HOME`:** a workspace of `/`, `$HOME` or a parent of `$HOME` is refused.

**The rest of the run under `--sandbox`:**
- The file tools (Read/Write/Edit/Grep/Glob) get `--confine-to-cwd`: they run in Sando's own process, outside the OS
  sandbox.
- The `js` (node REPL) tool is refused for the same reason.
- **No MCP server starts** (user config, plugins, the workspace, the built-in `node_repl`): each one runs in or from
  Sando's own process. A stdio server is an unconfined child process. An http one acts with its own credentials: the
  Planner plugin carries the owner's token, so a "locked" run could call `run_agent` (a cloud engine), `mail_self`,
  `web_search` or `read_thread`. There is no `load_tools` either (red team 2026-11-18, `bootstrap/src/app/runtime-config.ts`).
- **The workspace's `.zcode/config.json` and `zcode.json` are not read** (`adapters/src/config/project-config.adapter.ts`,
  one `config_project_ignored_by_sandbox` warning per file). Their keys act outside the OS sandbox:
  - `mcp.servers`: started at startup, unconfined (it read `~/.ssh/id_ed25519` in the red team);
  - `plugins.dirs`: a workspace plugin's hooks and MCP servers;
  - `network.httpProxy`: every provider request, so the whole conversation, through a proxy the repo names;
  - `storage.dir`: Sando writes its session store outside the workspace.
  - Project hooks were already blocked (they need workspace trust).
- **The git guard** (`core/src/tool/os-sandbox-git-guard.ts`). Sando itself runs git unconfined in the workspace (the
  context snapshot, checkpoints), and so does the user later. So before and after each sandboxed Bash call, the guard
  compares the repo's program-running config with the last known state:
  - the keys checked: `core.fsmonitor`, `core.hooksPath`, `core.pager`, `core.editor`, `core.sshCommand`, filters,
    diff/merge drivers, credential helpers, `gpg.program`, aliases, includes and more;
  - a config that gained one is restored, and a new config is moved aside and replaced by a minimal one;
  - a new or changed hook is renamed `*.sando-blocked`;
  - plain changes (`user.email`, remotes, branches) stay;
  - the model gets a `[Sando sandbox git guard: …]` line.
- **Sando's own git runs** get `core.fsmonitor=false` through `GIT_CONFIG_COUNT/KEY/VALUE`.
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
`"sandbox": {"mode","runner","enforcement","landlockAbi","widen","mcp","projectConfig"}` when the sandbox is on, e.g.
`{"mode":"workspace-write","runner":"landlock","enforcement":"full","landlockAbi":8,"widen":"none","mcp":"off","projectConfig":"ignored"}`.
A launcher should require `mcp: "off"` and `projectConfig: "ignored"`: builds before 2026-11-18 do not report them, and they
still started MCP servers and read the workspace config under `--sandbox`.

**Cost:** about 17 ms per Bash call (python3 start + about 47 rules). A bare `bash -c true` takes 1.6 ms, a sandboxed one
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

- `cli/test/sando-os-sandbox.e2e.test.mjs` (12). Each runs the built CLI headless with a scripted model:
  - **Blocked** (8 attacks): `cat ~/.ssh/id_ed25519`; `cat` of a file outside; writes outside by `echo >`,
    `python3 -c` and `node -e`; TCP connect to a listener the test runs (python and node); a unix-socket connect to a
    socket the test listens on. The listeners count zero connections, and nothing appears outside.
  - **Control:** without `--sandbox` the same commands all get through.
  - **Env:** `HF_TOKEN` / `CIVITAI_API_KEY` are empty inside; other vars pass.
  - **Works:** shell build steps, `node --test` (pass 1 / fail 0), `git init/add/commit`, python `tempfile` in
    `$TMPDIR`, and `cd dist` carrying over to the next call (the cwd capture).
  - **`/dev/stderr` and a linked worktree:** `> /dev/stderr` works. `git commit` works in a linked worktree, while
    writing the main repo's `.git/hooks` or `.git/config` is denied.
  - **Git guard:** a planted `core.fsmonitor` and `pre-commit` hook are undone, with a note, and the next call sees
    them gone.
  - **read-only mode:** the workspace is readable but not writable.
  - **File tools:** `Read ~/.ssh/id_ed25519` is refused.
  - **Fail closed:** no usable sandbox (`SANDO_SANDBOX_RUNNER=none`) refuses before any model request; with
    `--sandbox-widen unconfined` the run goes ahead and the JSON says `runner: none`.
  - **Widening:** refused without `one-call`; with it, one call out and the second refused.
  - **Bad values:** bad flag values fail before any model request.
- `adapters/test/sando-os-sandbox.test.mjs` (7):
  - chain order and reasons, partial, other platforms, the forced runner;
  - policy paths: `~/.ssh`, `~`, `/`, `/tmp`, `/run`, `/mnt` are never granted;
  - Landlock and bwrap argv;
  - the env filter (names, URLs with passwords, caches);
  - granting the output file; worktree git dirs;
  - the real launcher on this host: probe; writes, truncate and read outside fail; inside works; `socket()` is EPERM,
    `socketpair()` works; keyctl, `clone(CLONE_NEWUSER)`, `open_tree` and `perf_event_open` are EPERM; `clone3` is
    ENOSYS; fork still works; exit 125 on its own errors.
- `core/test/sando-os-sandbox-policy.test.mjs` (6): knobs; a bad value fails closed; per-call decisions; widening once
  per session; the `js` refusal and the implied `--confine-to-cwd`; the denial note.
- `core/test/sando-os-sandbox-git-guard.test.mjs` (5):
  - the config parser (every header form);
  - restore and hook disabling; a plain change kept;
  - a new repo's config moved aside;
  - the `GIT_CONFIG_*` hardening;
  - refusing `/`, `$HOME` or a parent of `$HOME` as the workspace.

## 4. Red team and A/B

See `FLEET-REPORT.md` (2026-11-18 port 3 entry). The kit is `~/apps/fleet/work/sando-os-sandbox/`: `run.sh`,
`queue.sh`, `sbxstats.py`, `redteam.sh`, `replay.mjs`, `hostcheck.mjs`. Raw runs are in
`/mnt/storage/scratch/sando-os-sandbox-1118/`.

## 5. Not covered / known limits

- **No sockets at all, loopback included.**
  - A test suite that starts a local HTTP server, or a dev server, fails inside the sandbox.
  - Landlock rules are per port, not per address, and seccomp cannot read the address. "Loopback only" needs a
    network namespace (bwrap), which AppArmor blocks here.
- **`.git` in the workspace is writable** (Landlock cannot subtract a subdirectory from an allowed tree). The git guard
  undoes program-running config and new hooks, but not:
  - repos nested deeper in the workspace;
  - a hook that a *background* command plants and Sando's own git runs before the next Bash call (only fsmonitor is
    switched off for Sando's git);
  - `.gitattributes` that select a filter already defined in the user's global config (e.g. git-lfs, which is the
    user's own program).
- **`/proc` is readable** (`/dev/stderr`, `<(…)` and Node's `process.memoryUsage()` need `/proc/self`, and Landlock
  cannot grant a child its own pid):
  - so the command lines of other processes are readable, while their environ, fd, cwd and root are not (Landlock
    ptrace scoping);
  - on the forge, a running `cloudflared` has `--token` in its argv, which any local process can read, sandbox or
    not;
  - file metadata (`stat`, existence, size) outside the workspace is visible too: Landlock does not restrict stat.
- **Not inside the sandbox:**
  - what runs in Sando's own process: WebFetch/WebSearch (network; not in the `lean-local` tool list), the user's own hooks
    and plugin hooks (from `~`, not the workspace), and the provider connection. MCP servers are off under `--sandbox`;
  - processes Sando starts itself: the shell-init snapshot (the user's login shell, as upstream).
  - The sandbox is for Bash. The file tools are covered by `--confine-to-cwd` instead.
- **Readable by design:** `/etc` and every `PATH` directory.
- **`/tmp` and `/dev/shm` are not shared:** a tool that hard-codes `/tmp` instead of `$TMPDIR` fails, and so does
  Python `multiprocessing.Lock()`. The npm cache under `~` is not readable, so `npx` of a package that is not
  installed in the workspace fails (it would need the network anyway).
- `/` itself and `~` are not listable.
- **Not verified:**
  - **bwrap:** the rung is built and its argv is unit-tested, but it cannot run on this host.
  - **The launcher is x86_64 only.** Elsewhere the probe fails and Sando fails closed.
  - **Interactive approval for the widening** (ask the user in the TUI/web) is not built; the flag is the approval.
- **Session resume:** the one-call widening is counted per session id in memory, so a new process gets a new one.
- **A background job outlives the run:** `(sleep 45; …) & disown` was still running after Sando exited. It stays confined
  (same Landlock domain, no network), but nothing stops it. The launcher should run Sando in its own cgroup (a
  `systemd-run --user` service is killed whole when Sando exits).
- **What a sandboxed run leaves in the workspace** (hooks under `.husky/`, `.gitattributes`, `.zcode/config.json`,
  `.claude/settings.json`, symlinks to `~`) is the launcher's problem: whoever copies the result back must not run git hooks
  on it or follow its symlinks. The Planner does that through the dsh apply (`sandoApplyBack`).
