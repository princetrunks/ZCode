# Sando per-model compaction headroom (spec)

Runner-up from the DeepSeek Harness study (`docs/dsh-study-2026-11-17.md` §3, branch `fleet/dsh-study-20261117`),
Planner SAN-4472. Done before port 2 (on-demand MCP tools) at Chuck's request. Idea from dsh (MIT): its trigger is
`min(W×0.8, W−O−65536)`; no code copied.

## 1. Why Sando compacted at ~35 % of a 32k window

Upstream (ZCode) compacts when the conversation reaches

```
threshold = W − min(O, 21,000) − 13,000          W = model contextWindow, O = max output tokens (32,000 if unset)
```

The 13,000-token buffer and the 21,000 output reserve were tuned for 200k windows. With `maxOutputTokens 8192`:

| window | upstream threshold | share of the window |
|---|---|---|
| 16,384 | 0 (compacts before every request) | 0 % |
| 24,576 (crack-voice, O 4,096) | 7,480 | 30 % |
| 32,768 (Lily, Qwythos, Gemma, qwen38) | 11,576 | **35 %** |
| 65,536 (Bonsai 2) | 44,344 | 68 % |
| 131,072 (CRACK) | 109,880 | 84 % |

That is the whole cause. These were checked and are **not** the cause:
- **The token count** is the server's own `prompt_tokens` from the last response plus a chars/4 estimate of what was
  added since (`buildProviderUsageTokenOverride`). It includes the system prompt and tool schemas, which is correct:
  they take up the window too. In the port-1 32k runs, compaction fired at 10,791–11,647 real prompt tokens.
- **Sando trusts `contextWindow` from the config.** The live source is `~/.zcode/v2/provider_config.json`
  (`modelConfigRules.manualProviderModelRules[].config.properties.contextWindow`), not `~/.zcode/cli/config.json`.
  No default maximum and no lean-profile cap apply: the live build, run on a copy of the live config against a
  scripted server, logs `contextWindow 131072 → threshold 109,880` for forge-crack and `32768 → 11,576` for forge-lily.
- A model with **no output limit** reserves 21,000 tokens. On a 32k window that alone is 64 %.

So on CRACK at its real 128k, Sando already used ~84 % before this change. The 35 % was the 32k bench setting, and it
is real for every 32k model (Lily, Qwythos, Gemma, qwen38).

## 2. The new trigger

```
O' = min(O, 21,000, W / 4)                       output reserve, capped at a quarter of the window
H  = model properties.compactHeadroomTokens  or the default by window below
threshold = min(W × 0.85, W − O' − H)
```

| window W | default H | threshold (O = 8,192) | share |
|---|---|---|---|
| ≤ 24,576 (16k, 24k) | 2,000 | 16k: 10,288 · 24k (O 4,096): 18,480 | 63 % · 75 % |
| ≤ 49,152 (32k) | 3,000 | 21,576 | **66 %** |
| ≤ 98,304 (64k) | 6,000 | 51,344 | 78 % |
| > 98,304 (128k+) | 13,000 (upstream) | 128k: 109,880 (unchanged) | 84 % |

- Per model: add `"compactHeadroomTokens": N` next to `contextWindow` in a model's `properties`
  (`manualProviderModelRules`). An explicit `compact.bufferTokens` in the runtime config still wins, as upstream.
- The tool-result pruner (port 1) and microcompact start at 90 % of this threshold (minus 2k), so they move with it:
  on 32k from ~9.6k to ~19.4k tokens.
- Why 3,000 on 32k is enough: after the check the next request still has `O'` (8,192) reserved for its answer, and
  the per-request output cap (`resolveModelStepMaxOutputTokens`) shrinks the answer to what is left. The summary
  request itself asks for at most `min(O, 20,000)` and has the reactive prompt-too-long path as a fallback.
- Decision logs (`compact.auto.*`) now carry `headroomMode` and `headroomTokens`.

## 3. The switch

```sh
SANDO_COMPACT_HEADROOM=upstream sando ...   # the upstream formula, exactly (alias: off)
# unset / auto / on = per-model headroom; any other value is a startup error
```

## 4. Tests

- `core/test/sando-compact-headroom.test.mjs`: upstream numbers unchanged in `upstream` mode, defaults by window, the
  forge's windows, the W×0.85 cap, a model with no output limit, per-model H and `bufferTokens`, the env switch, and
  `shouldAutoCompact` at 15k / 22k tokens on 32k.
- `cli/test/sando-compact-headroom.e2e.test.mjs` (built CLI, scripted server with `realisticUsage`, prompt_tokens =
  request chars / 4): six ~3k-token Bash results on 32k compact upstream and not with the new trigger; ten still
  compact; a bad value fails before any request.
- `cli/test/sando-spill-headtail.e2e.test.mjs` (port 1): the pruner case was sized for the upstream 32k trigger and now
  pins `SANDO_COMPACT_HEADROOM=upstream`.

## 5. A/B

See `FLEET-REPORT.md` (2026-11-17, compaction headroom). Kit: `~/apps/fleet/work/sando-headroom-ab/`.
