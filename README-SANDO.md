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

## Planned additions

- A Planner plugin (`.zcode-plugin/plugin.json` with `mcpServers` → the Planner's `/mcp`) so the Overseer tools
  (`render_h3_scene`, `decide`, `train_lora`, engine status, …) are available inside the harness.
- A forge provider preset and the superpowers skills index used by the other local runners.
- A Sando logo (torii + path mark) replacing `public/logo/icons`.
