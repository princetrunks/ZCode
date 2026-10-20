# Sando reasoning profiles (spec, 2026-10-19)

How Sando replays a reasoning model's own thinking in later requests, per model. Evidence and A/B numbers:
`REPORT.md` on branch `fleet/sando-reasoning-models-20261019`.

## Owner and order of events

```
core MessageHistory (keeps every assistant reasoning block, also across --resume)
  -> adapters runner.projectRequestHistory            <- reasoning profile applied here (once per logical request)
       -> [anthropic only] normalizeReasoningHistory (upstream: cross-model signed thinking, orphans)
  -> transform.toAiSdkMessages -> @ai-sdk serializer  (openai-compatible: reasoning_content; anthropic: thinking + signature)
  -> fetch chain: reasoning-field fetch (deepseek.com only) -> option-map fetch (effort + max tokens) -> transport
```

The profile is the single owner of "which reasoning goes back". Effort and output caps stay where upstream put them:
the config rules in `config/provider/zcode-builtin.json` (a personal manual model rule replaces them, as before).

## Policies

| policy | what goes back | used by |
|---|---|---|
| `passthrough` | exactly what Sando sent before profiles (= every turn's reasoning) | every model no profile matches: all forge models |
| `keep-all` | every turn's reasoning, unchanged (signed thinking stays signed) | MiniMax M2, M2.1, M2.5, M2.7, M3, M3.1-Flash |
| `keep-all-with-tools` | every turn when the request declares tools; otherwise only reasoning after the last user message | DeepSeek V3.x, V4, V4.1 (`deepseek-*`) |
| `keep-current-turn` | only reasoning after the last real user message (tool results and reminder-only user messages are not a new turn) | none by default; available through the override |
| `strip` | nothing | none by default; available through the override |

- Match is on the model id (case-insensitive, vendor prefix allowed: `minimax/minimax-m3`, `deepseek/deepseek-v4.1-flash`).
- `SANDO_REASONING_HISTORY=<policy>` forces one policy for every model (A/B runs, debugging). Unknown values are ignored.
- A reasoning-only assistant message that loses its reasoning keeps its place as `(no content)` (upstream's placeholder),
  so user/assistant alternation never changes.
- DeepSeek on an OpenAI-compatible `*.deepseek.com` host: every assistant message carries `reasoning_content`, empty
  when the turn had none (turns from another model, turns without thinking). No other host passes through that wrapper.

## Effort and caps (config rules)

| model | levels Sando offers | wire | output cap |
|---|---|---|---|
| MiniMax-M3.1(-Flash) | low, medium, high, xhigh, max (default max = server default; no `disabled`: the API 400s) | Anthropic: `thinking:{type:adaptive}` + `output_config.effort`; OpenAI: `reasoning_effort` | 131072 |
| MiniMax M2.x / M3 | upstream rules (unchanged) | upstream | upstream |
| DeepSeek V4 / V4.1 | upstream rules (unchanged: disabled, low, high, max) | upstream | upstream (384000 for V4.1-Flash) |

## Acceptance

- Forge models: request bodies byte-identical to the base build for the same scripted session
  (`scripts/sando-compare-request-bodies.mjs <before.cjs> <after.cjs> <modelId>`).
- `apps/zcode-cli/packages/adapters/test/sando-reasoning-profiles.test.mjs` (policies, matching, field patch).
- `apps/zcode-cli/packages/cli/test/sando-reasoning-profiles.e2e.test.mjs` (built CLI, 2 turns + `--resume`,
  `reasoning_content` on the wire per model, no-tools request, override).
