# Fleet report: Sando

## 2026-11-17/18: compaction headroom per model (branch only, not merged)

Planner SAN-4472 (task 4481), done before port 2 at Chuck's request. Branch `fleet/sando-headroom-20261117` from `sando`
(includes port 1), worktree `~/apps/fleet/wt/sando-headroom-20261117`, pushed to `origin`, NOT merged, no `sando-rebuild`,
`~/apps/sando-release` untouched. Spec: `SANDO-COMPACT-HEADROOM.md`. Run paused 11-17 ~23:35 UTC for the Danielle renders
and resumed 00:36 UTC; the CRACK run was already complete, so only the missing Bonsai cell plus a second rep were run.

**How much of CRACK's 128k Sando really uses (Chuck-facing)**
- **Before: 109,880 of 131,072 tokens (84 %). After: the same 109,880 (84 %).** [read] SANDO-COMPACT-HEADROOM.md §1–2
  (live build on a copy of the live config logs `contextWindow 131072 → threshold 109,880`).
- So the "~35 %" was never CRACK at 128k. It came from the port-1 bench telling CRACK it had 32k. It is real for every
  model configured at 32k: Lily, Qwythos, Gemma, qwen38 (11,576 of 32,768).
- Sando trusts `contextWindow` from the live config (`~/.zcode/v2/provider_config.json`). No default max or lean-profile
  cap. [ran] CRACK `/props` n_ctx 131072. The config gives forge-crack contextWindow 131072, forge-lily 32768,
  forge-bonsai2 **65,536** (not 32k: 44,344 → 51,344 tokens, 68 % → 78 %).
- On the bench no CRACK task got near the line: peak prompt 38k of 128k. Compactions 0 in both arms.

**Cause and fix** (details in the spec)
- Upstream threshold = W − min(O, 21k) − 13k. Those are fixed 200k-era reserves: 32k → 35 %, 16k → 0 % (it compacts on
  every request). The token count and system prompt/tool schemas are counted correctly; they are not the cause.
- New: min(W × 0.85, W − min(O, 21k, W/4) − H). H comes from the model's `properties.compactHeadroomTokens`, else the
  default by window: 16k 2k, 32k 3k, 64k 6k, 128k+ 13k (the upstream value).
- 32k → 21,576 (66 %). 64k → 51,344 (78 %). 128k unchanged.
- Switch: `SANDO_COMPACT_HEADROOM=upstream` (or `off`) restores the old formula exactly. A bad value fails at startup.

**Tests** [ran] in a CPU-capped unit, 2026-11-18 ~00:40 UTC
- `pnpm cli:build` OK.
- core 202/202 (8 new); adapters 16/16; cli 66 = 63 pass + 3 live red-team skips (needs a model), incl. new e2e
  `sando-compact-headroom.e2e.test.mjs`.
- `tsc --noEmit` clean in contracts, adapters, core, bootstrap, cli.
- Root `pnpm lint`: 0 errors, 72 warnings (same as port 1); the changed files have 0/0.
- Red-team: deterministic cases pass in the cli suite. The live suite was not run: this branch changes neither the
  prompt nor the tool list.

**A/B** [ran] (same build, `SANDO_COMPACT_HEADROOM=upstream` vs auto, lean-local, tasks t5–t9, hidden checks)
- **CRACK at its real 128k** (card 1, 22:55–23:22 UTC): upstream 5/5, auto 5/5, 0 compactions in both.
  - The trigger is identical at 128k, so the token and time differences between the arms (1.91 M vs 0.61 M prompt tokens)
    are run-to-run variance (one upstream t8 wandered to 64 requests), not an effect of the change.
- **Bonsai 2 told 32k** (card 0, rep 1 + rep 2 of the two tasks that compact, t6 and t8):

| arm | runs | pass | compactions | fired at (real prompt tokens) | prompt tokens | median s |
|---|---|---|---|---|---|---|
| upstream | 7 | 4/7 | 16 | 10,731–11,630 | 1.69 M | 406 |
| auto | 7 | 6/7 | 6 | 20,568–21,489 | 3.70 M | 546 |

  - On the compacting tasks only: auto 3/4, upstream 2/4. One of upstream's passes (r2 t8) hit the 1,200 s timeout and
    passed only because the check ran on the files it had written.
  - Cost: each request carries roughly twice the history, so total prompt tokens roughly double (llama.cpp's prefix
    cache absorbs much of this; wall time was mixed).
  - n is small (7 per arm, 1 model). It points the right way but is not proof.
- Kit and data: `~/apps/fleet/work/sando-headroom-ab/` (`queue.sh`, `resume/`, `analyze.py`, `runs/analysis.md`).
- Bonsai 2 was down (its restart failed during the renders). I started it under the card-0 lock for my cells and stopped
  it again after, which is the state I found it in. CRACK's unit was not touched.

**Not done / honest gaps**
- No live-model run at 16k/24k (crack-voice 24k goes from 30 % to 75 %); only unit tests cover those windows.
- The Bonsai rep 2 covers t6 and t8 only.
- No chart or render, so nothing was filed to My Hub or the workflow library.

**Needs Chuck** (also posted as a form)
- Merge `fleet/sando-headroom-20261117` into `sando`? (Port 1's branch is still unmerged too; this one includes it.)
- Default on merge: the per-model headroom (auto), or keep upstream and opt in per run?
- 32k headroom default: 3k (66 %) as built, or more conservative (6k ≈ 57 %)?
- 128k+: keep 13k (CRACK 84 %), or lower it so CRACK compacts at the 85 % cap (~111k)? The difference is small.
- Then start port 2 (on-demand MCP tools)?

## 2026-11-17: dsh port 1 — spill preview shows head + tail, tool-result pruner (branch only, not merged)

Planner SAN-4472 (task 4481). Branch `fleet/sando-spill-headtail-20261117` from `sando` (Sando has no `dev`; `sando` is
its working branch), pushed to `origin`, NOT merged, no `sando-rebuild`. Spec: `SANDO-SPILL-PRUNER.md`.

**What changed**
- **Spill preview** (`<persisted-output>`): first 2,000 chars, then `… N omitted …`, then the last ~1,000 chars (cut on
  line boundaries). Spill path line unchanged.
  - Found while testing: Bash keeps only the first ~30 kB of output inline. The first version took its "tail" from
    that head, i.e. from the middle of the log. A truncated Bash result now carries the output file's last 4 kB, so
    the tail is the real end of the log.
- **Tool-result pruner:** under compaction pressure, old tool results over 8,192 chars keep head 4,096 + tail 1,024
  with a marker in between. It never touches the 2 newest groups, makes no model call, and is idempotent.
  `SANDO_TOOL_RESULT_PRUNER=off` = upstream behaviour; an unknown value is a startup error.
  - Finding: upstream microcompact (the "clearing" the study meant) is **off by default in Sando**; nothing enables
    it. So before this branch old results were never trimmed, only summarised by full auto-compaction. The pruner
    runs on microcompact's trigger anyway; clearing stays as the fallback for an embedder that enables it.

**Tests** [ran]
- core 194/194 (17 new in `core/test/sando-spill-headtail.test.mjs`); adapters 16/16 (2 new); cli 63 = 60 pass + 3
  live red-team skips (needs a model), incl. new e2e `cli/test/sando-spill-headtail.e2e.test.mjs` 4/4.
- The e2e uses the built CLI and a scripted model:
  - a 101 kB Bash log shows its last line;
  - on a 32k window old results are pruned and keep their last line;
  - `off` prunes nothing;
  - a bad value exits before any request.
- The same e2e on the base build: spill and pruner tests fail.
- `pnpm typecheck` (root + contracts/adapters/core/bootstrap) clean; `pnpm lint` 0 errors (72 warnings, as before);
  `architecture:check --changed` OK.
- Red-team: deterministic cases pass (in the cli suite). The live suite was not run: it exercises the lean system prompt
  and tool list only (tool calls are stubbed), and this branch changes neither.

**A/B** [ran] (CRACK `qwen3.8-27b` :8097 on card 1 under `gpu-job-lock`, 19:52–21:23 UTC)
- Setup: Sando told the window is 32,768 (isolated HOME; the live unit untouched), `SANDO_PROMPT_PROFILE=lean-local`,
  base = `sando` @ 9156156 vs new = this branch. Tasks: lean-bench t5–t8 plus a new t9 (138k-char check log, the two
  errors in the last ~450 chars, noise from leftover DEBUG logging). 2 reps, interleaved.
- Kit: `~/apps/fleet/work/sando-spill-ab/` (`queue.sh`, `analyze.py`, `runs/analysis.md`).

| | pass | median s | prompt tokens | requests | spills | spill re-reads | tail/grep re-runs | pruned | full compactions |
|---|---|---|---|---|---|---|---|---|---|
| base | 8/10 | 98 | 999 k | 151 | 0 | 0 | 14 | 0 | 8 |
| new | 7/10 | 90 | 1,359 k | 194 | 0 | 0 | 9 | 6 results in 1 run | 10 |

- **Honest reading: on CRACK this A/B cannot show an effect either way.**
  - CRACK never let a log spill. In every t9 run, both arms, it piped the output to a file and ran `tail`/`grep`.
  - The pruner fired in 1 of 10 runs (t6 r1, 6 results, passed). The largest tool result in t5–t8 was 9.4k chars.
  - The one extra failure (t8 new r1, timeout) is a run where nothing was pruned or spilled, so its code path was the
    same as base. t8 is the high-variance task (base r2 also hit the 1,200 s timeout).
  - The token difference is mostly that run (468 k).
  - The mechanisms are shown by the deterministic e2e instead.
- **What the A/B did show:** on a 32k window Sando's *full* compaction dominates: t6 r1 (both arms) and all four t8 runs
  compacted, 2–5 times each. Upstream compacts at `32,768 − min(maxOut, 21k) − 13,000` ≈ 11.6k estimated tokens,
  about 35% of the window. That is the study's runner-up "per-model compaction headroom", and on 32k models it matters
  more than this port.

**Needs Chuck** (also in the form)
- Merge this branch into `sando` + `sando-rebuild`? Pruner default on (as built) or opt-in?
- Do the compaction-headroom runner-up before port 2 (on-demand MCP loading)?

## 2026-11-15: `--deny-commands` — Sando enforces the local-only shell block list (branch only, not merged)

Chuck asked for Sando to enforce the same bash deny list opencode gets in local-only chats. Branch
`fleet/deny-commands-20261115` (pushed, NOT merged to `sando`; ~/bin/sando and sando-release untouched). Planner side:
`fleet/sando-deny-wire-20261115` (off feature/ui-refresh-messages, pushed, not deployed, SANDO_LOCAL_ONLY_SAFE not set).

- `sando -p … --mode yolo --json --deny-commands deny.json` refuses a matching Bash call before it runs, in every mode,
  and never asks: the model gets "Refused by the deny list (--deny-commands): `git push origin main` matches the deny
  pattern "git push*". … Do not retry". Checked first in resolveToolPermission (before rules, hooks, yolo) and again in
  the Bash handler.
- Same glob as opencode (copied from its binary): `*` anything, `?` one char, trailing ` *` optional, whole command.
- Every command is checked on its own: `&& || ; |`, newlines, `( )`, `{ }`, if/for/while/case, functions, `$( )`,
  backticks, `<( )`, `sh -c`/`bash -lc` strings, eval, heredoc/here-string into a shell, wrappers (env, sudo, timeout,
  nohup, xargs, find -exec …), `VAR=…` prefixes, `/usr/bin/git`, `git -C x push`, `--request=POST`, `curl -sd`.
- Shell scripts are read too (`bash push.sh`, `source f`, `./f` with a shell shebang); a script that does not exist
  yet (written by the same line) refuses.
- Fails safe: `$G push`, `curl $FLAGS`, `echo … | sh`, unparsable input, a bad deny file. Git only needs a literal
  subcommand, so `git commit -m "$(cat msg)"` still runs. The `js` REPL tool is off while a list is active.
- The CLI reads the file once (missing/invalid/empty: exit 1 before any model call) and passes the patterns as JSON
  in SANDO_DENY_COMMANDS, so a Write to the file mid-run changes nothing.
- Not covered (not a sandbox): `python -c` / `node -e`, non-shell scripts, git aliases.

Tests [ran]: core 177/177 (133 in core/test/bash-deny-list.test.mjs: the Planner list, 69 refused forms, 34 allowed,
27 chain/nesting forms, fail-safe, scripts); cli 59 = 56 pass + 3 live red-team skips (needs a model), incl. the new
e2e cli/test/sando-deny-commands.e2e.test.mjs 3/3 (built CLI, headless yolo, stub model: `git push origin main` and
`curl -d x http://x` refused and never reach the fake programs, `git status` runs; a control run without the flag
executes all three). typecheck, lint, architecture:check OK.

To enable (Chuck): merge this branch into `sando` → sando-rebuild/release; merge + deploy the Planner branch; set
SANDO_LOCAL_ONLY_SAFE=1 for pp-server. Order matters: an old Sando exits on the unknown flag (fails closed).

## 2026-11-03: Board side pane — the Planner status board inside the Sando workbench (deployed, `1b809e4`)

Chuck asked for Sando to have the status board too. It is live on sando-web. The branch is `fleet/sando-board-20261103`
(`b29d592`, `09339f5`, `1b809e4`), fast-forwarded into `sando`, pushed to `private` and `origin`, then `sando-rebuild`.

- **Web:** the side pane has a new **Board** tab (`+` menu, or the "Open tab" launcher). It shows a Planner chat's status board
  with the same markdown as the chat (tables, mermaid). It has refresh, a "change board" picker (for the whole project or only
  this session), "open in Planner" and the board's full-report link. It polls every 10 s while visible. Tested: a line written to
  the board while the pane was open showed up by itself.
- **Phone:** a ▦ button next to the menu and new-chat buttons opens the same board as a drawer from the right. Tapping
  outside or ✕ closes it. The header title moved over so the button does not cover it.
- **Which chat:** a session pick, else the project pick, else the Planner chat linked to the workspace's project (matched
  by path, then folder name, then project name; a git worktree also tries its main checkout), else a new
  **"Sando · <project>"** chat with a starter board. `~/apps/ZCode` got **chat #567 "Sando · Sando"**.
- **The model keeps it:** a session with a board gets one short system section: "your board is Planner chat #N, keep it
  current with update_chat_status, chat_id N, one section per call". Sessions without a board get nothing, so their
  requests are unchanged. Tested: Bonsai 2 27B, headless, with no chat id in the prompt, wrote its result on #567.
- **How the pieces talk:** the browser calls the Sando server (`/api/sando/board/*`, behind the web token). The server
  calls the Planner on loopback with the token the Planner plugin already has (`mcp.json`). The token never reaches the
  browser. The pick is saved in `~/.zcode/v2/sando-boards.json`, and the agent runtime reads that file.

### How it was checked
- Core 44/44, CLI 52/52 (includes the phone-home guard and the red-team deterministic tests), server 8/8, UI 30/30.
  `pnpm typecheck` is clean. Lint has 0 errors (72 warnings, the same as before). `verify:pre-push` and the architecture check pass.
- Live red-team (kit, 43 cases, Lily 9B, under the GPU lock): without the board section 10 pass / 32 fail, then 8 / 33 on a
  repeat. With it, 8 / 32 twice. That is inside run-to-run noise, and the fail count never went above the baseline (33).
  Note: the "pass ≥ 9" gate already fails about one run in two on Lily with no changes at all.
- The chat title is outside text, so line breaks (including U+2028), controls and invisible smuggling characters are stripped,
  and the title is quoted before it goes into the prompt (tested with a hostile title).
- Screenshots (live): `~/apps/fleet/logs/sando-board-{desktop,phone,phone-header}.png`, also on chat 509's "🧩 Planner UI".

### Rollback
`rm -rf ~/apps/sando-release && mv ~/apps/sando-release.old ~/apps/sando-release && systemctl --user restart sando-web.service`

### Not done / limits
- The desktop (Electron) app has no Board: the Planner proxy lives on the web server.
- Images on a board load only in a browser that already has the Planner media cookie.
- Refresh is polling, not the Planner's `/events` socket (that one needs a ticket per connection).
- The Planner labels every MCP edit "Claude Code (MCP)", whichever model made it.

## 2026-10-29: Z.ai phone-home removed — `phonehome: none` (branch `sando`, RD-2828)

Chuck asked: "Any way to erase it from the code?" Yes. Commits `cbff8df` and `4c1f37c` on `sando` are pushed to
`origin` and `private`. I ran `sando-rebuild`, and the live workbench runs the new release.

- **What I found:** Beyond the hourly catalogue call, upstream also:
  - fetched client-config, client-scenes and help-config;
  - fetched the help config from your browser, so forge-side strace could never see it;
  - auto-refreshed the plugin store and loaded plugin icons from cdn-zcode.z.ai;
  - sent a device ID inside Anthropic-protocol model requests;
  - silently sent api.z.ai and open.bigmodel.cn model calls through zcode.z.ai.

  OTEL, ARMS and data-warehouse telemetry only send when their env vars are set (none are here). Update checks are
  desktop-only. Full table: the inventory in the Planner note on SAN "[Fleet] Sando: phonehome none".
- **What I built:** one switch, `phonehome`, with the default `none` (`packages/shared/src/phonehome.ts`,
  `scripts/sando-phonehome.mjs`). It removes all of the above, plus device-ID files, OTEL, update checks and Z.ai /
  BigModel login. The bundled catalogue drops the Z.ai / BigModel providers and templates.
  - Vendor default origins become `http://127.0.0.1:9`.
  - The CLI and services HTTP clients refuse `*.z.ai` / `*.bigmodel.cn`.
  - The builds turn the switch into a constant (define + `minifySyntax`), so the gated code can never run.
  - Some dead function bodies stay in the bundle, because esbuild doesn't tree-shake lazily initialised modules.
  - `SANDO_PHONEHOME=upstream` brings upstream behaviour back.
- **Guard test:** `test/sando-phonehome.test.mjs`. It checks:
  - that defaults are loopback only;
  - that the gated functions never call out;
  - that the bundle is folded;
  - a reviewed allowlist of hard-coded external URLs. A new external host in shipped source fails the test.
- **Proof** (fresh data dirs, env override removed, 10 min each under strace):
  - CLI: 10 runs, 0 external connects and no DNS lookups. `/pp-status` and 9 Lily "pong" prompts worked.
  - Web (new release on :3046): the server made 0 connects. A headless browser loaded the page twice: 66 requests,
    all to 127.0.0.1. Workbench 200.
  - Before the change, the same CLI run reached zcode.z.ai and its Alibaba CDN within seconds.
  - The live :3033 service returns 200, and the startup "refresh failed" warning is gone.
  - The env override stays in `web.env` and `~/bin/sando` as a second layer.
- **Tests:**
  - CLI 51/51 (3 skipped);
  - adapters 14/14, core 37/37, services 10/10;
  - typecheck, lint (no new warnings) and the architecture check are clean.
  - `packages/ui/test/nonCliAcpRetirement` fails the same way without my change (a `@/lib` alias tsx can't resolve).
- **Prompt-injection kit wired in** (`test/sando-redteam.test.mjs`, kit vendored under `test/redteam/kit`).
  - Live on Lily 9B with the lean-local prompt: **9/43 pass, 33 fail**, recorded as the baseline.
  - The fails are expected: Sando runs yolo with no gate, so the model's choices go straight through. (The kit stubs
    tools, so nothing actually ran.)
- **Untested:**
  - desktop (Electron) paths: gated, but desktop isn't built here;
  - a web-initiated agent prompt (the agent is the same CLI bundle as the CLI proof);
  - the `upstream` build mode.
- **Needs Chuck:**
  - Decide whether Sando should get a pre-execution gate, like the Planner's `toolGate`, for turns that read outside
    content. The red-team baseline shows the exposure.
  - The kept user-click links (zcode.z.ai docs, the share landing page) can be repointed or removed if you want.

## 2026-10-20: lean prompt profile for local models (branch `fleet/sando-lean-prompt-20261020`, Planner STP-2576)

I worked only in the worktree `~/apps/ZCode-fleet-lean`, based on the reasoning-models branch. I did not merge, run
`sando-rebuild` or touch `~/apps/ZCode`. The branch is pushed to `origin`. Full write-up: `REPORT-lean-prompt.md`; spec
and study notes: `SANDO-LEAN-PROMPT.md`.

- **Finding:** Sando's ~31k-token first request is mostly tool schemas, not prose. 26 tools come to ~28k tokens, and the
  9 dynamic-workflow tools alone ~21.5k; the system text is ~2.5k. The CL4R1T4S prompts (read as references only) and
  dsh agree on a short recipe:
  - each rule is stated once;
  - one rule line per tool that is actually present;
  - one-sentence tool descriptions.
- **Built:** an opt-in `SANDO_PROMPT_PROFILE=lean-local` (or `lean`).
  - It gives a ~1.8k-char prompt plus Read/Write/Edit/Bash/TodoWrite with short descriptions. The user's own MCP tools
    are kept.
  - It only applies to models whose provider URL is loopback or private-network (new `Model.localEndpoint`).
  - The main session only; subagents and workflows are unchanged.
  - **Unset is unchanged:** request bodies are byte-identical to the base build, both CLI-only and full build.
- **Live A/B on Bonsai 2 27B** (resident, nothing switched): the 4 tasks from the reasoning study plus 4 new harder ones,
  × 2 reps, scored by hidden checks.
  - Pass rate: **lean 14/16 = default 14/16**.
  - Prompt tokens: **3.7× fewer**. First request: **16.5× smaller** (31.6k → 1.9k).
  - Wall time: **2.4× less**.
  - Compaction: default 12 times, lean 0.
  - Ablation: default with only the workflow tools removed (an existing flag) comes out at −24% tokens.
- **Tests:** core 37/37, CLI 39/39, adapters 14/14; `pnpm run build` OK; typecheck clean.
- **Needs Chuck:**
  - review the branch, and merge it if you want it;
  - decide whether `lean-local` should become the forge default in `sando-rebuild`/sando-web env;
  - optionally an A/B on CRACK, which needs a forge-mode switch I was not allowed to do.

## 2026-10-19/20: reasoning profiles for DeepSeek V4.x / MiniMax M3.x (branch `fleet/sando-reasoning-models-20261019`)

Worked only in the worktree `~/apps/ZCode-fleet-reasoning`; did not touch `~/apps/ZCode`, run `sando-rebuild` or merge.
Pushed to `origin`. Full write-up with citations and numbers: `REPORT.md`; spec: `SANDO-REASONING.md`.

- **Finding:** Sando already replays every turn's thinking (`reasoning_content` / signed `thinking`), which is what MiniMax
  M2–M3.1 require and what DeepSeek's own V4.1 encoder does when tools are declared. dsh (DeepSeek Harness 0.2.1-rc.2) does
  the same. Proven on MiniMax M3.1 Flash (free, OpenRouter): the model recalls a number that only existed in its previous
  thinking 2/2 with replay, 0/2 without.
- **Built:** per-model reasoning profiles (default `passthrough` = unchanged; MiniMax `keep-all`; DeepSeek
  `keep-all-with-tools`), empty `reasoning_content` for DeepSeek on deepseek.com, MiniMax M3.1 effort levels (no
  "disabled") + 131k cap, `SANDO_REASONING_HISTORY` override, a before/after request-body diff script.
- **Tests:** core 31/31, CLI 35/35 (+5 e2e), adapters 12/12 (new), typecheck clean. Forge request bodies byte-identical to the
  base build (bonsai2-27b, qwen3.8-27b, torii-1.5-9b).
- **Live (Bonsai 2 27B, 4 synthetic tasks × 2):** before 8/8, after 8/8, thinking-on keep 8/8, thinking-on strip 8/8,
  dsh 8/8 with ~5× fewer prompt tokens (Sando's ~31k system prompt is the real local-model cost). MiniMax M3.1 Flash
  through Sando: 16/16.
- **Forge:** neither new model is useful here (V4.1-Flash is 552B / smallest GGUF 233 GB; M3.1 weights not out, M3-sized
  would be ≥91 GB). Planner STP-2565 re-checks M3.1 on Oct 23.
- **Needs Chuck:** review/merge the branch; a `DEEPSEEK_API_KEY` (and/or `MINIMAX_API_KEY`) in the vault plus an OK for a
  few cents of spend if you want the DeepSeek path tested live; decide whether to start the "lean prompt for local models" work.

## 2026-10-18: answerable forms + run flags (branch `fleet/sando-forms-20261018`)

Worked only in the worktree `~/apps/ZCode-fleet-sando`. I did not touch `~/apps/ZCode` (the `sando` branch that sando-web serves),
run `sando-rebuild`, restart `sando-web.service` or merge anything. The branch is pushed to `origin` (github-zcode). It is not
pushed to `private`, which is the remote `sando-rebuild` pulls from.

### What's done (one commit per concern)
1. **```form blocks in the web workbench** (`58a3d54`). A finished assistant reply's ```form fence (JSON: title, intro, fields of
   type choice / multi / yesno / scale / text, with required / note / other / min / max / placeholder / multiline) now renders as
   chips and boxes. Send composes `Form answers: <title>` + one line per question (skipped ones say "(skipped)") +
   `answers-json: {…}`, the same contract the Planner shipped today. That text goes out as the next user message in that
   session, through the composer's normal path. A running turn queues it, and a held queue keeps its items.
   - The form shows "Sent" only once the send is accepted. That state is remembered per session (localStorage), so it survives
     a reload, and "Change answers" re-opens it.
   - Read-only surfaces (shared conversation, previews) say they can't send rather than pretend to.
   - Phone: 44 px tap targets and 16 px inputs.
   - Code: `packages/ui/src/lib/formSpec.ts` (pure, a port of the Planner's), `components/ai-elements/form-block.tsx`, hook in
     `message.tsx`, listener in `v4/SessionPane.tsx`, en-US / zh-CN strings.
2. **The agent knows about it** (`a3f4d11`). There is one line in the always-on # Harness block (`core/src/context/sections/identity.ts`)
   and a short section in the shrinetech-planner skill. Both say: one form at the end of a reply, only for several real
   decisions, never in voice.
3. **Run flags from the Harness² proposal** (`dead834`, `7cc4ae8`). All four are implemented, so none needed a write-up instead.
   The proposal diff was a sketch, so I re-implemented it against the real code.
   - `--model <provider>/<model>`: this run only, nothing saved. It is checked against the registry, and a bad value is a clear
     error. (The configured default silently falls back to the first model.)
   - `--harness <dir>`: `<dir>/AGENTS.md` is added after your own and the project's AGENTS.md, so project rules come first.
     `<dir>/skills` and `<dir>/agents` are also loaded.
   - `--max-turns <n>`: caps model steps per user turn. The last step runs without tools, so the run ends with a text answer.
     I used a new field rather than the existing `maxTurns`. That one was never enforced, and subagents already default it
     to 4, so turning it on would have suddenly capped every subagent.
   - `--confine-to-cwd`: Read / Write / Edit / Grep / Glob and the Bash working directory refuse paths outside the workspace
     (or the harness dir). Symlinks are resolved first, so a link pointing outside is refused too.
4. **SANDO-ROADMAP.md** is updated: forms are done on this branch, and the flags are listed with their status and limits.

### How it was checked
- **Forms:** 6 unit tests (`pnpm exec tsx --test packages/ui/test/formSpec.test.ts`). The UI package typechecks and the web
  bundle builds in the worktree (`packages/web`, `vite build`).
- **Forms in a browser:** headless Chromium on a throwaway local page (port 5299, since closed) that renders the real
  `MessageResponse`, at desktop and phone (390 px) widths. It showed the required-field warning, chips, the Other box, the
  composed message, the "Sent" lock, and "Sent" still showing after a reload. Screenshots:
  `~/apps/fleet/logs/sando-form-{desktop,phone}-{open,sent}.png`.
- **Flags:**
  - Core tests 15/15 (`pnpm test` in `apps/zcode-cli/packages/core`), including 8 that drive the real Write / Read / Glob
    handlers with confinement on.
  - CLI tests 9/9 (`pnpm test` in `apps/zcode-cli/packages/cli`), including an end-to-end test of the built CLI against a
    scripted local OpenAI-compatible server with a throwaway HOME. No GPU or network was used. It checks:
    - `--max-turns 3` makes exactly 3 model calls, and the last one offers no tools.
    - `--model` hits the other model and leaves `provider_config.json` alone.
    - Bad values exit 1 before any model call.
    - Confinement refuses `/etc/hostname` but still reads the workspace README.
    - `--harness` puts its AGENTS.md and skill into the prompt.
  - Without `--max-turns`, the same scripted loop made about 600 model calls in 90 s.

### Not done / limits / untested
- **Not tested inside the real workbench:** the form send against a live model session. The browser check used the real
  renderer with a stand-in listener. The SessionPane send path typechecks, but no real session exercised it (that needs a
  sando-web build). Try it after promotion: ask the agent for a form and answer it, both while idle and while a turn runs.
- **What `--confine-to-cwd` does not cover:** what a running Bash command or the node REPL touches, MCP tools and web tools.
  Pair it with the shell gate / permission mode. Workflow-script paths were not reviewed.
- **Partial checks:** `--harness <dir>/agents` is wired but only typechecked (no end-to-end check). The proposal's `hooks.json`
  for harnesses (c8) is not done.
- **Leftovers:**
  - The bad-model error text is upstream's Chinese message ("Provider Registry 中不存在 Model: …").
  - I did not run the full `pnpm build:zcode` release build (that is `sando-rebuild`'s job). I built `packages/web` and the
    CLI packages instead.
  - `pnpm install` in the worktree made a local `node_modules` (gitignored).
- **Not done here, because it is outside Sando:** the Planner's TTS strip and other surfaces.

### What Chuck needs to decide
- Promotion: review this branch, merge it into `sando`, then run `sando-rebuild`. Because `sando-rebuild` pulls `private sando`,
  the branch is not deployed until it is merged and pushed there.
- Should Harness² launchers (`sovereign_h2/sando.py`) switch to `--model --harness --confine-to-cwd --max-turns`? That would stop
  them writing into the workspace and using a private HOME.
