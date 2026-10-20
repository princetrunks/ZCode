# Sando and the new reasoning models: report (2026-10-19/20)

Branch `fleet/sando-reasoning-models-20261019` (worktree `~/apps/ZCode-fleet-reasoning`), based on `sando` @ 2e05fa4.
Not merged, no `sando-rebuild`, nothing deployed. Spec: `SANDO-REASONING.md`.

## TL;DR

- **Sando already did the most important thing right.** Core keeps every assistant reasoning block for the whole session
  (also across `--resume`), and the request serializers send it back on every turn: `reasoning_content` on the
  OpenAI-compatible path, signed `thinking` blocks on the Anthropic path. That "keep all thinking" is exactly what MiniMax
  M2–M3.1 require, and it is also what DeepSeek V4.1 does whenever tools are declared (which is every Sando agent step).
  Measured: replay works through OpenRouter on MiniMax M3.1 Flash (the model recalls a number that existed only in its
  previous turn's thinking 2/2 times with replay; 0/2 without).
- **What the upgrade adds:** an explicit per-model *reasoning profile* (so this behaviour is a decision, tested on the
  wire, not an accident of the SDK), DeepSeek's exact rule for requests without tools, the empty `reasoning_content`
  DeepSeek's own API wants on the OpenAI path, and correct MiniMax M3.1 Flash effort levels + output cap (upstream would have
  offered "disabled", which M3.1 rejects with a 400, and capped output at 32k against MiniMax's recommended 131k).
- **Every current forge model behaves exactly as before:** request bodies are byte-identical between the base build and
  this branch for the same scripted session (bonsai2-27b, qwen3.8-27b, torii-1.5-9b). Live Bonsai 2 27B runs: 8/8 before,
  8/8 after (plus 16/16 with thinking switched on per request, keep vs strip).
- **What dsh's "+8 points on Terminal-Bench" is made of** is mostly not reasoning plumbing (Sando's matches it); it is
  DeepSeek-specific prompting, a repeat-tool-call guard, tool-output pruning and compaction tuned to a 1M window — see
  "What was borrowed" and "What's left". Measured on our Bonsai 2 27B: dsh and Sando both 8/8, but dsh used ~5× fewer
  prompt tokens and was ~2.5× faster — Sando's ~31k-token system prompt, not reasoning, is the lever for local models.
- **Forge feasibility:** neither new model is useful on the forge. DeepSeek V4.1-Flash is 552B (not 284B: that is V4-Flash),
  smallest GGUF 233 GB, no mainline llama.cpp. MiniMax M3.1 Flash weights are not out; if it is M3-sized (428B/23B, press,
  unverified) its smallest quant is ~91 GB. Only DeepSeek **V4**-Flash (284B/13B, UD-IQ1_S 83 GB) could be squeezed into a
  solo mode, at IQ1 quality. Planner task STP-2565 re-checks M3.1 on Oct 23.

## 1. Findings, with citations

### DeepSeek (V4 / V4.1-Flash)

| point | evidence |
|---|---|
| Thinking from earlier turns is **kept when the request declares tools** and dropped (before the last user message) only when it does not | DeepSeek-V4.1-Flash-1017 `encoding/encoding.py:785-791` (`if any(m.get("tools") ...): effective_drop_thinking = False`), `:749-767` (`_drop_thinking_messages`), `:562-582` (last-user index: mid-conversation system messages count as a user turn, tool-result-only messages do not); `encoding/README.md:163-171` |
| dsh (official harness, `deepseek-ai/deepseek-harness` @ 687f282 = tag `dsh-v0.2.1-rc.2`) replays reasoning on **every** earlier turn; signature only for the same model | `packages/llm/llm-deepseek/src/serialize.ts:26-38`, `replay.ts:63` |
| dsh's OpenAI route (pi-ai) echoes reasoning under the field it came in (`reasoning_content`), turns other models' thinking into text, and adds an **empty `reasoning_content`** to every assistant message for `deepseek.com` URLs | pi-ai 1.1.0 `dist/api/openai-completions.js:400-415, 984-1012, 1047-1050, 1272`; `transform-messages.js:66-90` |
| Effort: off / low / high (default) / max → `thinking:{type}` + `output_config.effort` (Anthropic) or `reasoning_effort` (OpenAI); no budget tokens. The open-weights encoder also takes 1–100 | `llm-deepseek/src/model-info.ts:10-31, 88-96`, `serialize.ts:147-156`; pi-ai `openai-completions.js:668-679`; `encoding/README.md:17-22, 260-266` |
| Output cap 256,000, context 1,000,000; no temperature / top_p defaults | `llm-deepseek/src/defaults.ts:6,8`; `serialize.ts:154,158` |
| Tool calls: plain Anthropic `tools` (no strict); malformed JSON → kept raw → schema error returned to the model as an error tool result (no retry loop); no DSML parsing in the harness (DSML is only inside the open-weights encoder) | `serialize.ts:160-166`; `core/agent-loop/src/tool-calls.ts:105-111`; `core/tools/src/schema.ts:466,597-599`; `core/tools/src/index.ts:1917-1924`; `encoding.py:156,524` |
| Model-keyed logic: `deepseek-flash` (= V4.1-Flash) puts system-prompt changes in history (`systemPromptUpdate:'in-history'`); default model `deepseek-flash` | `models.ts:6-21`; `serialize.ts:64,110-115`; `bundle/base/cordis.patch.yml:94` |
| Compaction at min(0.8×window, window − max_tokens − 65,536); LLM summary in `<compacted-summary>`; tool results pruned at 8192 chars (head 4096 / tail 1024) | `compaction/compaction-basic/src/config.ts:20,23,75,153-193`; `summarizer.ts:22`; `bundle/base/cordis.patch.yml:417,428` |
| Repeat-tool-call guard: a reminder when the same call repeats 3, 5, 8 times | `bundle/base/cordis.patch.yml:451`; `guard/repeat-tool-reminder/src/index.ts:70-80` |

So the "harness effect" @Beamsters1 measured (Terminal-Bench 32 → 40+) is not a secret reasoning trick: dsh does what
DeepSeek's encoder does. The rest is ordinary harness engineering (prompt, guard, pruning, compaction) tuned for the model.

### MiniMax (M2 … M3.1 Flash)

| point | evidence |
|---|---|
| Thinking **must be returned in full on every turn**; M3.1 Flash on the OpenAI API returns it as `reasoning_content` "which must also be preserved completely"; on the Anthropic API thinking blocks carry a `signature`, "return unchanged" | platform.minimax.io `docs/guides/text-m3-function-call`, `docs/api-reference/text-openai-api`, `docs/api-reference/text-anthropic-api` |
| Cost of stripping (M2, MiniMax's own numbers): Tau² 87 → 64, BrowseComp 44.0 → 31.4, SWE-bench Verified 69.4 → 67.2 | minimax.io/news/why-is-interleaved-thinking-important-for-m2; MiniMax-M2 HF card ("Do not remove the `<think>…</think>` part") |
| M3 open-weights template renders reasoning for **every** assistant turn | `MiniMaxAI/MiniMax-M3` `chat_template.jinja` |
| Effort (M3.1 Flash only): low / medium / high / xhigh / max, default max; `none` → 400; thinking cannot be disabled (`thinking:{type:"disabled"}` → 400, only `adaptive`); no budget tokens; recommended `max_tokens` 131,072, max 524,288 | platform.minimax.io `docs/guides/text-generation` |
| MiniMax Code (`MiniMax-AI/minimax-code` @ c21e88e, MIT, built on pi-mono): Anthropic transport, signed thinking echoed back, effort catalog `default/low/medium/high/xhigh/max` (default = omit), 128K output | `packages/local-runtime/src/model-provider/minimax-api.ts:7-12`; `third_party/pi-mono/packages/ai/src/providers/anthropic.ts:687-692, 1164-1198`; `packages/config/src/minimax-model-catalog.ts:32-53`; `packages/local-runtime/src/model-provider/thinking.ts:124-146` |
| Sampling: temperature 1.0, top_p 0.95 (M3/M3.1) | HF generation_config; platform docs |

### Sando before this branch (audit, base 2e05fa4)

| point | where |
|---|---|
| Core keeps reasoning blocks in history, also when a session is re-hydrated | `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts:119, 562-575`; `agent/message-history.ts:498-516` |
| Request projection: reasoning-history normalization ran **only for Anthropic** (cross-model signed thinking removed, orphans/trailing reasoning cleaned); OpenAI-compatible got the history untouched | `adapters/src/model/runner.ts:357-372` (base); `reasoning-history-normalization.ts:31-40, 92-108` |
| OpenAI-compatible serializer (`@ai-sdk/openai-compatible` 2.0.60) sends `reasoning_content` for every assistant message that has reasoning, and reads `reasoning_content ?? reasoning` | `node_modules/@ai-sdk/openai-compatible/dist/index.mjs:225-255, 592, 728` |
| Effort + output cap = per-model CEL "option maps" patched into the JSON body; forge manual rules use `map: "{}"` (nothing sent) | `adapters/src/model/model-option-map-fetch.ts`; `packages/model-option-map`; `~/.zcode/v2/provider_config.json` |
| Upstream already had DeepSeek V4/V4.1 and MiniMax M2/M3 rules; **nothing for M3.1**: it inherited M3's `disabled/enabled` levels and a 32,000 cap | `config/provider/zcode-builtin.json` (MiniMax-M3 model rule; DeepSeek v4.1 rules) |
| `supportsMidConversationSystem: false` (all forge models): mid-conversation system text is rendered as user-role `<system-reminder>` messages, sometimes inside a tool loop | `core/src/runtime/helpers/runtime-provider-request-messages.ts`, `provider-request-messages.ts:54-66` |
| Every forge llama-server runs `--reasoning off` (CRACK, Bonsai, Lily), so today no forge model returns reasoning and the replay path is dormant | systemd units `llama-server-crack.service`, `bonsai2_launch.sh` (`ps` of PID 2000025) |

## 2. What was built

1. **`adapters/src/model/reasoning-profiles.ts`** — per-model profile table + policy engine:
   `passthrough` (default, = before) | `keep-all` | `keep-all-with-tools` | `keep-current-turn` | `strip`.
   - MiniMax M2…M3.1 → `keep-all` (MiniMax docs; MiniMax Code).
   - DeepSeek V3/V4/V4.1 → `keep-all-with-tools` (DeepSeek's encoder; dsh). In practice: identical to before for agent
     steps; a request without tools (summaries, `--max-turns` final step) drops thinking from before the last user message.
   - `currentTurnStart` ignores tool results and reminder-only user messages (forge models get reminders as user messages).
   - `SANDO_REASONING_HISTORY=<policy>` override for A/B and debugging.
2. **`runner.ts`** applies the profile for every provider kind, before upstream's Anthropic normalization.
3. **`reasoning-field-fetch.ts`** — DeepSeek on a `*.deepseek.com` OpenAI-compatible host gets `reasoning_content: ""` on
   assistant messages that lack it (borrowed from pi-ai/dsh). Any other host bypasses the wrapper entirely.
4. **`config/provider/zcode-builtin.json`** — MiniMax-M3.1(-Flash): levels low…max (default max = server default), output cap
   131,072, context 1M; Anthropic map `thinking:{type:adaptive}` + `output_config.effort`; OpenAI map `reasoning_effort`.
5. **Tests**: adapters 12 (policies, matching, field patch, M3.1 rules through the real config + option-map evaluator);
   CLI e2e 5 (built CLI, 2 turns + `--resume`, `reasoning_content` on the wire per model, no-tools request, override).
6. **`scripts/sando-compare-request-bodies.mjs`** — same scripted session through two builds, diff every request body.

### What was borrowed, and why

| from | what | why |
|---|---|---|
| DeepSeek's own V4.1 encoder (`encoding.py:785-791, 749-767`) | `keep-all-with-tools`: keep every turn's thinking when tools are declared, drop pre-last-user thinking otherwise | it is how the model was trained/served; dsh agrees (`serialize.ts:26-38`) |
| dsh's pi-ai route (`openai-completions.js:1047-1050, 1272`) | empty `reasoning_content` on assistant turns for `*.deepseek.com` | DeepSeek's OpenAI endpoint wants the field on thinking-mode tool loops; harmless elsewhere so scoped to that host |
| MiniMax docs + MiniMax Code catalog (`minimax-model-catalog.ts:32-53`, `thinking.ts:124-146`) | M3.1 levels low…max with server-default max, adaptive thinking, 128K-class output cap, keep-all history | thinking cannot be disabled on M3.1; MiniMax's own harness sends exactly these fields |
| not borrowed (yet) | dsh's repeat-tool-call reminder, tool-output pruning, compaction thresholds, smaller system prompt | model-agnostic harness engineering; each needs its own A/B (see "What's left") |

## 3. Results

### Tests (all on this branch, `pnpm --filter "@zcode/cli..." build` first)

| suite | before (base) | after |
|---|---|---|
| core (`pnpm test`, apps/zcode-cli/packages/core) | 31/31 | 31/31 |
| CLI (`pnpm test`, apps/zcode-cli/packages/cli) | 30/30 | 35/35 (+5 reasoning e2e) |
| adapters (new `pnpm test`) | — | 12/12 |
| adapters `tsc --noEmit` | clean | clean |
| oxlint on changed files | — | no errors (package-wide `pnpm lint` fails on a pre-existing `marketplace.ts` max-lines error, untouched) |

**Byte-identical forge requests** (`scripts/sando-compare-request-bodies.mjs`, same scripted 2-turn session + `--resume`, the
model streams `reasoning_content` on every step, ids/timestamps normalized): bonsai2-27b, qwen3.8-27b, torii-1.5-9b → ALL
IDENTICAL, 4/4 requests each. deepseek-v4-flash differs only where intended.

### Live, Bonsai 2 27B on :8100 (resident; nothing switched, no GPU claim), 4 synthetic tasks × 2 reps, scored by hidden tests

Tasks (in `~/apps/fleet/work/sando-reasoning/tasks`): t1 fix `median()` (even length + ValueError), t2 implement `slugify`
from a docstring (accents), t3 write `parse_duration` from a README spec + its tests, t4 rename `calc`→`cart_total`
across two files + add a validated `discount_pct`. Hidden checks are stricter than the visible ones. All runs 23:17–00:57 UTC.

| series | what | pass | median s | total requests | prompt tokens | completion tokens |
|---|---|---|---|---|---|---|
| before | base build, thinking off (as deployed) | **8/8** | 89 | 95 | 3.29 M | 21 k |
| after | this branch, thinking off | **8/8** | 83 | 109 | 3.87 M | 36 k |
| think-keep | this branch, thinking **on** per request (`chat_template_kwargs.enable_thinking`), replay all (= Sando default) | **8/8** | 158 | 75 | 2.58 M | 73 k |
| think-strip | same, `SANDO_REASONING_HISTORY=strip` | **8/8** | 130 | 72 | 2.39 M | 35 k |
| dsh | DeepSeek Harness 0.2.1-rc.2 headless, pi-ai OpenAI route, same server, thinking off | **8/8** | 36 | 85 | 0.63 M | 16 k |

- before vs after: same behaviour by construction (Bonsai runs `--reasoning off`); the totals differ only by sampling noise —
  one after-run of t3 wandered for 648 s / 52 requests and still passed (median 83 vs 89 s).
- Thinking on/off and keep/strip made **no pass/fail difference** on these small tasks. Keeping thinking roughly doubled
  completion tokens and was slower (n = 8, not significant). Bonsai's template keeps all past thinking by default
  (`preserve_thinking` undefined → keep), so on the forge "replay" really reaches the model.
- **dsh vs Sando on our model: same 8/8, but ~5× fewer prompt tokens and ~2.5× faster.** The difference is not reasoning
  handling (Bonsai thinks not at all here): dsh's system prompt is a few thousand tokens, Sando's is ~31k
  (127k prompt tokens for a 4-request task). On a 65k-window local model that is the single biggest lever — it is the
  roadmap's "context discipline" item, now measured.

### Cloud, MiniMax M3.1 Flash (`minimax/minimax-m3.1-flash:free` on OpenRouter, $0; `OPENROUTER_KEY` via `creds env`, injected by a local proxy, never written to a file)

| test | result |
|---|---|
| Does replayed thinking reach the model? Turn 1 thinks a random 6-digit number (only in its thinking) and calls a tool; turn 2 asks for it | replayed as `reasoning_content`: recalled 2/2; as `reasoning`: 2/2; as `reasoning_details`: 2/2; **nothing replayed: 0/2** (CANNOT_SEE / a different number). So Sando's `reasoning_content` replay works through OpenRouter, and stripping would blind the model |
| Sando (this branch) on the 4 tasks, default profile (keep-all) × 2 | **8/8**, median 22 s, 60 requests |
| same with `SANDO_REASONING_HISTORY=strip` × 2 | **8/8**, median 20 s, 47 requests |

No DeepSeek cloud run: no DeepSeek key in the vault (`creds check DEEPSEEK`: none) and every DeepSeek model on OpenRouter is
paid (V4.1-Flash ~$0.035/M in, still > $0). Not run without Chuck's OK.

## 4. Forge feasibility (24 GB VRAM, 94 GB RAM, i9-13900K)

`free -g` at 23:13 UTC: 94 GB total, 47 used, 46 available (voice stack, comfy, Lily, Bonsai up). Precedent: Torii Coder
125B at IQ1_M = whole card + ~25 GiB RAM (strata mode, parks the voice stack).

| model | size (verified) | smallest GGUF | llama.cpp | fits? | verdict |
|---|---|---|---|---|---|
| DeepSeek **V4.1**-Flash(-1017) | 552B backbone (incl. 196B Engram), 8B/16B active prefill/decode; ~510 GB FP8+FP4 (our download: 401 GB so far, `/mnt/storage/models/foundry`); `inference/config.json`: 40 layers × 384 experts (6 active) × 3×5120×2304 ≈ 543B routed-expert params | unsloth UD-IQ1_S 233 GB, UD-Q2_K_XL 335 GB (needs draft PR #30817) | not mainline (PR #30817 draft, #28696 open) | no: 2.5× RAM+VRAM; every token would stream experts from NVMe | **not useful** (sub-1 tok/s territory, 31k-token Sando prompt would take many minutes). Keep it as a foundry/distillation teacher as planned |
| DeepSeek **V4**-Flash | 284B / 13B active, ~160 GB | unsloth UD-IQ1_S 83 GB, UD-Q2_K_XL 97 GB | supported | IQ1_S only, in a solo mode: ~22 GB VRAM + ~61 GB RAM, voice stack and most services parked | **possible but poor**: IQ1 on a 13B-active MoE loses a lot; estimate ~5–15 tok/s decode from RAM bandwidth; not measured. Only worth a try if a coding A/B against CRACK/Bonsai justifies the solo mode |
| MiniMax **M3** | 428B / 23B active; BF16 854 GB, MXFP8 444 GB | IQ1_S ~91 GB, Q2_K 152 GB (bartowski/unsloth) | mainline (#24908, parser #26210), dense-attention fallback | no (91 GB > usable RAM+VRAM) | not useful |
| MiniMax **M3.1 Flash** | weights not released (official: "later"; press: Oct 23, 428B/23B — unverified) | — | — | unknown | re-check Oct 23 (STP-2565). If it really is M3-sized: no |

Sources: HF model cards / API for `deepseek-ai/DeepSeek-V4.1-Flash`, `deepseek-ai/DeepSeek-V4-Flash`, `MiniMaxAI/MiniMax-M3(-MXFP8)`,
unsloth/bartowski GGUF repos, unsloth.ai/docs/models/deepseek-v4.1-flash, llama.cpp PRs named above. Speeds are estimates, not
measurements; nothing was loaded on the GPU.

If one of them ever runs on the forge: start llama-server **with** reasoning (not `--reasoning off`), give the model id a
name the profiles match (`deepseek-v4…`, `minimax-m3…`), and set the manual rule's reasoning map (e.g.
`{"chat_template_kwargs": {"enable_thinking": true}}`) — Sando will then replay thinking the way each model wants.

## 5. What's left / not done

- **Context discipline is the real local-model gap, not reasoning.** dsh solved the same tasks with ~1/5 of the prompt
  tokens. Next step: a lean Sando prompt profile for ≤64k local models (measure which of the ~31k tokens matter: tool
  schemas, skills index, Planner plugin, # Harness block), plus dsh's tool-output pruning (8192 chars → head 4096 / tail 1024)
  and its repeat-tool-call reminder (3/5/8 repeats). Not built here (out of this brief's scope; each needs its own A/B).
- **DeepSeek on the Anthropic path** (`api.deepseek.com/anthropic`, the builtin DeepSeek provider): upstream's
  `normalizeReasoningHistory` drops *signed* thinking from other models entirely, where dsh keeps the text unsigned.
  Left as upstream (cross-model switching mid-session is rare).
- **Untested live:** DeepSeek V4/V4.1 (cost), MiniMax via its own API (no key), the Anthropic path for either, and a
  reasoning model served *locally* with a template that drops thinking (none on the forge today).
- **Harder tasks.** All 56 live runs passed; the task set is too easy to separate the policies. A Terminal-Bench-style set
  (multi-file, long tool loops) is needed to see the MiniMax/DeepSeek "keep thinking" effect on pass rates; the probe above
  shows the mechanism, not the benchmark gain.
- **`SANDO_REASONING_HISTORY`** is a global env override; a per-model user override in `provider_config.json` would need a
  schema field (manual model rules are a fixed pick-list) — deliberately not done.
- **Review/merge:** Chuck. Rebase risk is low: one new file pair in adapters, a 20-line change in `runner.ts`, a one-line
  fetch wrap in `model-execution.ts`, two additive rule blocks in `zcode-builtin.json`, additive test-server fields.

## Artifacts

- Runs, logs, proxies, task set, probe: `~/apps/fleet/work/sando-reasoning/` (`runs/results.txt`, `runs/results-or.txt`,
  `or_probe_run{1,2}.json`, `proxy-before.jsonl` = every Bonsai request body).
- dsh clone + local install + Bonsai patch: `~/apps/fleet/work/dsh/` (`local-patches/bonsai-proxy.cordis.yml`).
- MiniMax Code clone: `~/apps/fleet/work/minimax-code/`.
