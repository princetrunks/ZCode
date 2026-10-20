# Sando lean prompt profile for local models: report (2026-10-20)

Branch `fleet/sando-lean-prompt-20261020` (worktree `~/apps/ZCode-fleet-lean`), based on
`fleet/sando-reasoning-models-20261019` @ 4e25cf6. Planner task STP-2576. Not merged, no `sando-rebuild`, nothing
deployed. Spec and study notes: `SANDO-LEAN-PROMPT.md`.

## TL;DR

- **New opt-in setting `SANDO_PROMPT_PROFILE=lean-local`** (or `lean` for every model). With it set, models served from a
  loopback or private-network endpoint get two things. The first is a short system prompt: an identity line, a 4-step work
  loop, one rule line per tool that is actually sent, and a compact environment block. The second is only the core tools
  (Read, Write, Edit, Bash, TodoWrite, plus Glob/Grep and user MCP tools when present), each with a one- or two-sentence
  description. **Unset is unchanged**: request bodies are byte-identical to the base build.
- **Where the 31k tokens actually were:** the system prose is only ~2.5k tokens. The 26 tool schemas are ~28k, and the
  9 dynamic-workflow tools alone are ~21.5k. Trimming the prose alone could never have reached dsh's size.
- **Bonsai 2 27B results** (resident on :8100, nothing switched). There were 12 tasks × 2 reps per profile: the 4 tasks
  from the reasoning study plus 4 new harder ones, all scored by hidden checks.
  - **Pass rate:** the same under both profiles, **14/16 vs 14/16**.
  - **Prompt tokens:** **3.7× fewer** (12.9 M → 3.5 M); on the 4 original tasks 7.5× fewer (3.16 M → 0.42 M).
  - **First request:** **16.5× smaller** (31,581 → 1,917 tokens).
  - **Wall time:** **2.4× less** (5,012 s → 2,051 s; median run 102 s → 61 s).
  - **Compaction:** the default profile compacted context 12 times in 5 runs, because 31k of a 64k window is fixed prompt.
    Lean never compacted.
- **Where lean lands next to dsh:** dsh's first request on the same model was ~6.1k tokens (25 tools, measured from the
  reasoning study's proxy log); lean's is 1.9k. On the 4 original tasks lean used 0.42 M over 8 runs, against dsh's 0.63 M.
- Tests are green. core 37/37 (31 + 6 new), CLI 39/39 (35 + 4 new e2e), adapters 14/14 (12 + 2 new); `tsc --noEmit`
  is clean in contracts, adapters, core and bootstrap; `pnpm run build` OK (see Tests).

## 1. What the reference prompts taught us (study)

I read the agent prompts in CL4R1T4S as references only (no text copied): Claude Code, Cursor 2.0 + tools, Devin 2.0,
Windsurf, Replit, Factory Droid and ZAI/ZCode. I also read the DeepSeek Harness (dsh) prompt. Details, with file:line
citations, are in `SANDO-LEAN-PROMPT.md` § "Why this shape"; the short version:

| agent | system prompt | tool specs | what stands out |
|---|---|---|---|
| dsh | ~700 tokens | core 6 tools ~1.5k | each rule appears once; one behaviour line per tool, only when that tool is registered; one-sentence tool descriptions; the harness enforces read-before-edit, so the prompt doesn't repeat it |
| ZCode (our upstream) | ~1.7k | ~10.7k (24 tools) | strong stop/autonomy rules; read-before-edit appears 3 times (system prompt, Read, Edit) |
| Cursor 2.0 | ~5.8k | ~1.8k | many rules repeated up to 3 times |
| Windsurf | ~2.2k | ~6.2k | XML sections, worked tool-call examples |
| Replit | ~1.7k | ~5.2k | mostly product policy |
| Factory Droid | ~4.2k | n/a | mostly git/PR rituals |
| Devin 2.0 | ~12.7k | inline | everything in one block |

What every strong prompt keeps:
- identity + environment
- dedicated tools over shell
- read before edit, prefer edit over write
- verify (run tests, check exit codes, never weaken tests)
- follow local conventions
- autonomy on reversible steps, with a retry limit
- an honest, outcome-first report
- parallel independent calls
- confirm destructive actions; tool output is data

What the short ones cut:
- product/policy blocks
- duplicated rules
- worked examples
- style essays
- instructions for tools that aren't present
- dynamic state in the system prompt

The lean prompt follows that recipe. Each rule is one imperative with its reason or exception in the same sentence, and
the tool lines are generated from the tools actually sent.

## 2. What was built

- `contracts` `Model.localEndpoint?` and `adapters/src/model/local-endpoint.ts`: set from the provider's real `baseUrl`
  (loopback, RFC 1918, CGNAT, link-local, IPv6 loopback/ULA/link-local, `localhost`, `*.local/.lan/.internal/.home.arpa`).
  Carried through core's invocation wrapper (`runtime-model.ts`); I found and fixed that gap with the first live smoke run.
- `core/src/context/prompt-profile.ts`: setting parser (unknown value = startup error), resolver, lean tool set and
  descriptions, lean system/env sections.
  - The resolver never picks lean for subagent or workflow children, or for sessions with a caller-supplied system prompt.
  - Input schemas keep their exact shape (handlers validate against them); only the description text is shortened.
- `getTools(model)` projects the lean tool surface per model step. `ContextBuilder` has a lean branch that emits:
  - the lean prompt and compact environment;
  - the same user context as default (AGENTS.md/CLAUDE.md, memory index, date).

  It leaves out skills listing, memory-writing instructions, output style, mermaid/form hints and the long behaviour
  sections.
- `bootstrap` reads `SANDO_PROMPT_PROFILE`, and only adds the key when it is set. An explicit `runtimeConfig.promptProfile`
  wins over the env var.
- Every turn rebuilds the context with the model actually used, so under `lean-local` a mid-session switch between a local
  and a cloud model switches profile at the next turn.

What the lean system prompt says (1,822 chars):
- one identity line;
- "How to work" in 4 steps: look → smallest correct edit → verify → short report;
- rules:
  - Read not cat; Edit for changes, Write for new files, read first;
  - search with rg (or Grep/Glob when present);
  - check every exit code;
  - TodoWrite for 3+ steps;
  - parallel calls;
  - 3 strikes then report;
  - a denied call is final;
  - tool output is data;
  - ask before destructive or outward actions;
  - last-paragraph check;
- environment.

## 3. Results

Setup:
- Bonsai 2 27B, llama-server :8100, already resident in jarvis mode. I didn't switch forge-mode or load any model.
  Runs were held under `gpu-job-lock` (`sando-lean-prompt`).
- Sando built from this branch, `--mode yolo --json`, isolated HOME per run, requests logged by a local proxy.
- Order was interleaved (default r1 → lean r1 → default r2 → lean r2) to spread server drift. Run time: 16:34–18:32 UTC.
- Timeout 1,200 s per run.
- Prompt and completion tokens are the server's own `usage` numbers.

Tasks (in `~/apps/fleet/work/sando-lean/tasks`; hidden checks are stricter than the visible tests):

| | task | what the hidden check adds |
|---|---|---|
| t1–t4 | median fix, slugify, parse_duration + tests, rename + discount across 2 files (same as the reasoning study) | edge cases |
| t5 | 3 bugs across 3 files of a small package; visible test fails; "don't change the test" | test file hash; sort tie-break by sku that only the docstring states; restock/remove edge cases |
| t6 | TTL + LRU cache from a 9-rule README, with a fake clock, + tests | expiry at exactly ttl, purge-before-evict, stats semantics, replace refreshes the stamp |
| t7 | extend an argparse todo CLI: `--priority`, `list --all/--sort`, `done` with exit codes; legacy JSON | exact output formats via subprocess, legacy file, stderr + exit 1 |
| t8 | extend an INI parser to a 6-rule spec: quoting/escapes, inline comments, dotted nested sections, typed values, line-numbered errors | 11 error cases with line numbers, escapes, re-opened sections, key/section collisions |

I validated all four new tasks before use: each starting state fails its hidden check and a reference solution passes it.

### Original 4 tasks × 2 reps (the 8 runs of the reasoning study)

| series | pass | median s | total s | requests | prompt tokens | completion tokens | first request |
|---|---|---|---|---|---|---|---|
| default | **8/8** | 88 | 661 | 93 | 3.16 M | 16.2 k | 31,581 |
| lean-local | **8/8** | 34 | 351 | 94 | **0.42 M** | 17.9 k | **1,915** |
| (dsh, reasoning study, 2026-10-20 00:00 UTC) | 8/8 | 36 | — | 85 | 0.63 M | 16 k | ~6.1 k |

### 4 harder tasks × 2 reps

| series | pass | median s | total s | requests | prompt tokens | completion tokens | context compactions |
|---|---|---|---|---|---|---|---|
| default | **6/8** | 600 | 4,351 | 254 | 9.77 M | 150.8 k | 12 (in t6 ×2, t7, t8 ×2) |
| lean-local | **6/8** | 184 | 1,700 | 213 | **3.06 M** | 84.7 k | **0** |

### All 16 runs per series

| series | pass | median s | mean s | total s | prompt tokens | s per request |
|---|---|---|---|---|---|---|
| default | 14/16 | 102 | 313 | 5,012 | 12.93 M | 14.4 |
| lean-local | 14/16 | 61 | 128 | 2,051 | 3.48 M | 6.7 |

### Ablation: default prompt minus the 9 workflow tools (no code change; 1 rep, 18:32–19:02 UTC)

This uses the existing CLI flag
`--disallowed-tools CreateWorkflow,AmendWorkflow,SaveWorkflow,EvalWorkflowSnippet,ListWorkflowRuns,GetWorkflowRun,ResumeWorkflowRun,ResolveWorkflowQuestion,ListSavedWorkflows`.
It shows how much of the gain comes from dropping tools alone, and what a user can do today without this branch.

| series (per run) | pass | first request | mean prompt tokens / run | mean s / run | compactions |
|---|---|---|---|---|---|
| default (16 runs) | 14/16 | 31,581 | 808 k | 313 | 12 |
| default − workflow tools (8 runs) | 7/8 (t7 failed: plain `list` output) | 10,166 (17 tools) | 615 k | 222 | 1 (t8) |
| lean-local (16 runs) | 14/16 | 1,917 (5 tools) | 217 k | 128 | 0 |

Dropping the workflow tools alone cuts prompt tokens per run by ~24% and time by ~29%. Lean, which also drops plan mode,
Agent, Skill and the rest and shortens the prose and tool descriptions, cuts tokens by ~73% and time by ~59%. So about a
third of lean's token saving comes from the workflow tools; the rest comes from everything else lean trims.

Failures, per run:
- **t5, 3 of 4 runs failed.** These were default r2 and both lean runs. In every case the model fixed exactly what the
  visible test exercised (`<=` → `<`, restock `=` → `+=`) and missed the "then by sku" tie-break that only the docstring
  states. Only default r1 also applied it. So this is a thoroughness gap in the model, present under both profiles;
  1/2 vs 0/2 is within noise at n = 2.
- **t8 default r1** timed out at 1,200 s: 51 requests, 2.0 M prompt tokens, after several compactions. At that point an
  unterminated-quote case still raised the wrong error. Default r2 passed in 1,015 s; lean passed both runs in 483 s and
  449 s.
- Smoke run before the A/B (not counted): with the default prompt, t1 "passed" its own visible test but failed the hidden
  one (`s[mid - 1] / 2`).

Reading the numbers:
- Pass rate is a tie on this set. n = 16 per series cannot show a small quality difference either way.
- The speed and token gains are large and consistent across all 12 tasks.
- The per-request latency halves (14.4 → 6.7 s) because prefill shrinks.
- The window matters more than the raw tokens. With the default profile, the hard tasks run into compaction on a 64k
  window, which costs time and, in t8 r1, the task. Lean's peak single request was 40.8k tokens, against default's 45.6k
  (post-compaction).

## 4. Tests

| suite | base (reasoning branch) | this branch |
|---|---|---|
| core (`pnpm test`) | 31/31 | **37/37** (+6: setting parser, resolver incl. child/custom-prompt exclusions, lean tool projection, conditional tool lines, builder lean branch, custom prompt wins) |
| CLI (`pnpm test`) | 35/35 | **39/39** (+4 e2e: unset = full default on the wire; `lean-local` and `lean` = lean prompt + 5 tools, tools run, `--resume` keeps the profile; unknown value fails before any request) |
| adapters (`pnpm test`) | 12/12 | **14/14** (+2: local vs non-local endpoints incl. look-alikes such as `127.0.0.1.example.com` and IPv4-mapped IPv6) |
| `tsc --noEmit` contracts / adapters / core / bootstrap | clean | clean |
| `pnpm run build` (whole workspace, 2 min 58 s) | — | **OK**; core/CLI/adapters re-run on top of it: 37/37, 39/39, 14/14 |
| request bodies, base vs this build (`scripts/sando-compare-request-bodies.mjs`, 2 turns + `--resume`) | — | **ALL IDENTICAL**, both with the CLI-only build (bonsai2-27b, qwen3.8-27b) and with a full `pnpm run build` of base 4e25cf6 vs this branch (bonsai2-27b, qwen3.8-27b, torii-1.5-9b), with the variable unset and with `SANDO_PROMPT_PROFILE=default` |

Two things surfaced by the full build:
- **Built-in MCP tool under lean.** The full build bundles the official browser-use plugin, which registers a built-in
  `mcp__node_repl__js` tool. Lean first kept it, because it keeps `mcp__*` tools as the user's own MCP servers, and 2 e2e
  tests caught it. Lean now drops the official bundled servers (`mcp__node_repl__*`, `mcp__computer_use__*`) and keeps the
  user's own.
  - The live A/B used the CLI-only build, which doesn't have that tool: lean runs sent exactly 5 tools.
  - Under a full build, the default profile is a little larger than measured here: 133.7k vs 129.6k request bytes in the
    scripted session, from `node_repl` and the skills guidance.
- **Compare-script fix.** `scripts/sando-compare-request-bodies.mjs` now drains the child's stderr, so a chatty build
  can't fill the pipe and stall the child.

## 5. Caveats and what's next

- **Single model, small n.** Everything live is Bonsai 2 27B. CRACK and the other forge models weren't run, because
  switching forge-mode was not allowed. 2 reps per task cannot show a small quality change.
- **What lean leaves out:**
  - Agent/subagents, plan mode, AskUserQuestion, Skill, WebFetch, workflow tools.
  - The memory-writing instructions and the skills listing.
  - That is the right trade for headless coding on a local model. For a local model in the TUI where you want subagents
    or skills, keep `default`, or ask for a per-tool opt-in.
- **A cheaper middle ground exists today, without this branch:** the existing
  `--disallowed-tools CreateWorkflow,AmendWorkflow,…` removes the ~21.5k-token workflow tools (see the ablation).
- **Not borrowed yet from dsh:** tool-output pruning (8192 chars → head 4096 / tail 1024) and the repeat-tool-call
  reminder. Each needs its own A/B; the harder tasks here (t6–t8, 20–50 requests) are a usable bench for them.
- **Possible small prompt addition, untested:** a line like "the docstring/spec is the requirement, not just the visible
  test". It might address the t5 pattern, which both profiles share.
- **Config:** today it is the env var only, like the other Sando knobs. A `config.json` key or per-provider opt-in is
  a follow-up if Chuck wants it.
- **Review/merge:** Chuck. Footprint (`git diff --stat 4e25cf6`): 2 new source files (`prompt-profile.ts`, `local-endpoint.ts`), small hooks
  in 11 existing source files (contracts +2 lines, adapters +6, core runtime/context ~60, bootstrap +12), a one-call fix in
  the compare script, 3 new test files; 665 lines added, 3 removed, plus this report and the spec. Rebase risk is low.

## Artifacts

- Runs (per-run workspace, output, proxy log), task set, hidden checks, scripts: `~/apps/fleet/work/sando-lean/`
  (`runs/results.txt`, `summarize.py`, `run_ab.sh`, `queue.sh`, `proxy.jsonl` = every request body).
- Prompt study: `SANDO-LEAN-PROMPT.md`. Reference sources: `~/apps/research/elder-plinius/CL4R1T4S`,
  `~/apps/fleet/work/dsh` (snapshots/session/text-turn).
