# Sando

**Sando** (参道 — the approach path from the torii to the shrine) is ShrineTech's coding-agent harness: a fork of
[zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache-2.0) kept rebaseable on upstream. The internal workspace packages keep
their `@zcode/*` names on purpose; only the product surface is renamed.

## What is different from upstream

- Command name `sando` (the `zcode` bin is kept as an alias); product name Sando in the TUI, desktop and web.
- Community and feedback links point at ShrineTech, not Z.ai.
- Built and run on Phoenix Forge against local models (CRACK 27B and friends) through `openai-chat-completions` providers;
  Z.ai's OAuth login is untouched for anyone who wants their plan.
- Dispatched by the ShrineTech Project Planner's Overseer as the `zcode` engine of `run_agent` (headless `--prompt`).

## Build (forge, not a laptop)

Pinned toolchain from `mise.toml` (Node 24.14.0, pnpm 10.33.2). The workspace compiles native modules (node-pty, ssh2,
cpu-features); build it on a box with RAM to spare.

```bash
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --filter "@zcode/cli..." build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help   # or the ~/bin/sando wrapper
```

## No phone-home (`phonehome: none`, 2026-10-29)

The fork builds with one switch, `phonehome` (`packages/shared/src/phonehome.ts`; build side
`scripts/sando-phonehome.mjs`). The default, `none`, removes every vendor call-home path from the CLI, server and web:

- the zcode.z.ai remote Built-in catalogue (`/api/v1/client/configs` + the CDN JSON) and its hourly refresh. The
  local catalogue `config/provider/zcode-builtin.json` is staged without the Z.ai / BigModel account providers and
  templates, and any cached remote catalogue is overwritten by it;
- client-config, client-scenes and help-config fetches (server and browser), the plugin-store auto-refresh from
  cdn-zcode.z.ai and the CDN plugin icons;
- the device ID (`telemetry-state.json`, `X-Device-Mid`, Anthropic `metadata.user_id.device_id`);
- OTEL exporters (the `OTEL_EXPORTER_OTLP_*` vars are ignored), data-warehouse and ARMS telemetry;
- update checks (desktop auto-updater);
- Z.ai / BigModel login (`sando login|logout`, `/login`, the OAuth buttons in every UI) and the hidden reroute of
  api.z.ai / open.bigmodel.cn model calls through the zcode.z.ai gateway. Vendor default origins become
  `http://127.0.0.1:9`.

As a second layer, the CLI and services HTTP clients refuse `*.z.ai` / `*.bigmodel.cn` before any DNS lookup.
Bundlers fold the switch to a constant (`__SANDO_PHONEHOME__` define + `minifySyntax`), so the gated paths are
unreachable. Some dead function bodies stay in the bundle because esbuild does not tree-shake lazily initialised
modules. `SANDO_PHONEHOME=upstream pnpm build:zcode` restores upstream behaviour.
Guard: `apps/zcode-cli/packages/cli/test/sando-phonehome.test.mjs`. It checks loopback-only defaults and the gated
functions, and keeps a reviewed allowlist of hard-coded external URL literals (`sando-phonehome-hosts.json`), so any
new external host in shipped source fails the test.

## MCP tools on demand (`SANDO_MCP_TOOLS`, default since 2026-11-18)

Requests carry no MCP tool schemas up front. One `load_tools` tool lists every MCP tool (name + a summary of at most
160 characters, grouped by server); the model loads what it needs, or calls a listed tool directly, and the schema is
sent from the next request on. On the Planner's 80 tools that is about 18k fewer prompt tokens per request. Every
prompt profile. `SANDO_MCP_TOOLS=all` (or `eager`) is the off switch: every schema in every request, as upstream.
Spec and tests: `SANDO-MCP-ONDEMAND.md`.

## OS sandbox for Bash (`--sandbox`, 2026-11-18, off by default)

`--sandbox workspace-write` (or `read-only`; `SANDO_SANDBOX`) runs every Bash command in the OS sandbox:
- bwrap if it works, else Landlock + seccomp through a small Python 3 launcher (on the forge: Landlock ABI 8, `full`);
- writable: the workspace and a private `$TMPDIR`; readable: system dirs, toolchains and `PATH`;
- invisible: the rest of `$HOME` (`.ssh`, the vault…), `/tmp` and `/run`;
- no sockets of any kind; credentials dropped from the env;
- the file tools get `--confine-to-cwd`, and the `js` tool is off.

No usable sandbox means Sando refuses to start (fail closed) unless `--sandbox-widen unconfined`.
`--sandbox-widen one-call` lets one `dangerouslyDisableSandbox` Bash call per session out. The headless JSON reports
`sandbox: {mode, runner, enforcement}`. Spec, tests and limits: `SANDO-OS-SANDBOX.md`.

## Local model provider

Providers live in `~/.zcode/v2/provider_config.json` (schemaVersion 1): a personal provider rule with
`api: {type: "openai-chat-completions", baseUrl: "http://127.0.0.1:8097/v1"}`, `access: {type: "api-key", apiKey: "forge"}`,
`personalModelIds`, a **manual model rule** carrying every field of the manual schema, and `defaultModelSelection`.
A missing field drops the model silently and every turn fails with "Select a model before continuing" — the cause is in
`~/.zcode/cli/log/*.jsonl` under `error.cause`. Sando's system prompt is ~31k tokens, so the model needs a 128k window.

## Headless

```bash
sando -p "task…" --cwd /path/to/repo --mode yolo --json
```

prints one JSON object; the answer is `response`, request count in `usage.modelRequestCount`.

### `--deny-commands <json file>` (2026-11-15)

A JSON array of opencode-style patterns (or `{ "deny": [...] }`): a Bash call is refused before it runs when any command
in it matches, in every mode, headless included (it never asks; the model gets a "Refused by the deny list" tool error).
Semantics are opencode's: `*` = anything, a trailing ` *` is optional, the whole command must match. Each command of a
chain, pipeline, subshell, `$(…)`, `sh -c '…'` string and wrapper (`env`, `sudo`, `timeout`, `xargs`, `find -exec` …) is
checked on its own, `VAR=…` prefixes included. Fails safe: a run-time program name (`$G push`), an expanded argument to
a listed program (`curl $FLAGS …`), a shell reading from a pipe, unparsable input or a bad file all refuse; the `js`
REPL tool is off for the run. The file is read once at start (`SANDO_DENY_COMMANDS`), so editing it mid-run does
nothing. Shell scripts are read too (`bash f.sh`, `source f`, `./f` with a shell shebang); one that does not exist
yet at check time (written by the same line) refuses. Not a sandbox: `python -c` / `node -e` one-liners, non-shell
scripts and git aliases are not inspected. The Planner passes its local-only list
(LOCAL_ONLY_BASH_DENY). Code: `core/src/tool/handlers/bash-deny-list.ts`; tests: `core/test/bash-deny-list.test.mjs`,
`cli/test/sando-deny-commands.e2e.test.mjs`.

## Planned additions

- A Planner plugin (`.zcode-plugin/plugin.json` with `mcpServers` → the Planner's `/mcp`) so the Overseer tools
  (`render_h3_scene`, `decide`, `train_lora`, engine status, …) are available inside the harness.
- A forge provider preset and the superpowers skills index used by the other local runners.
- A Sando logo (torii + path mark) replacing `public/logo/icons`.
