# Fleet report: Sando

## 2026-10-21: per-session pending indicator + prompt-injection suite (branch `fleet/sando-pending-20261021`, Planner SAN-2610)

I worked only in the worktree `~/apps/ZCode-fleet-sando-pending`. I did not change `~/apps/ZCode`, run `sando-rebuild`,
restart `sando-web.service` or merge anything. The branch is pushed to `origin`. The look follows the Planner brief
(`chat-pending-indicator.md`); that worker had not built its UI yet, so the two may need a small alignment later.

### What was already there
Upstream's task list already had three markers:
- a spinner while a turn runs;
- a blue dot for an unread reply;
- an "Awaiting approval" pill for permission prompts and AskUserQuestion.

I kept all three. What was missing: queued and sub-agent counts, a marker for an unanswered ```form, any label a
screen reader could read (the status slot was `aria-hidden`), and anything in the open session's header.

### What I built (one commit per concern)
1. **CLI facts** (`d9f66ab`). `deriveSessionPendingFacts` in `shared` gives:
   - queued inputs;
   - whether the queue is paused;
   - running native sub-agents;
   - `awaitingForm`: the newest finished reply has a ```form fence, the user has not written since, and no turn is
     running.

   These go into `SessionSummary` as optional fields that are absent when zero. Old frames and old CLIs still parse.
   No thread text leaves the CLI. The projection already re-derives on every non-streaming event, so the counts stay
   live with no new subscription.
2. **Web** (`62625b1`, header fix `1114e31`).
   - Rows, both flat/timeline and grouped:
     - an amber dot when the session waits on you. It outranks unread and the spinner; error still wins.
     - chips for queued messages and running sub-agents. The queue chip is amber when the queue is paused.
     - a screen-reader label and a hover title, e.g. "Working… · 2 queued messages · 1 sub-agent running · New reply".
   - Header of the open session: "Working… · 2 queued messages" or "Waiting for your form answers", as a status region.
     - Below 768 px it shows only the icon and chips; the full sentence is in the tooltip and the label.
     - It reads the ref-counted sessions-index store the sidebar already holds.
   - en-US and zh-CN strings.
3. **Prompt-injection suite** (`876ff08`). The kit is vendored under `apps/zcode-cli/packages/cli/test/redteam/`.
   - `sandoAdapter.mjs` runs the real built CLI headless. Outside content is planted as a workspace file (page,
     search results, email, attachment) and read with the real Read tool.
   - "Executed" means it really happened on disk.

### Tests and checks
- Unit tests: `packages/ui/test/sessionPendingIndicator.test.ts` passes 10/10. It covers:
  - fence rules and the answered / superseded / streaming / running cases;
  - queue states and the sub-agent fallback;
  - wire compatibility;
  - projection upserts;
  - priorities;
  - labels in both locales.

  The other UI tests still pass (21/21). `pnpm typecheck` is clean. `pnpm lint` has 0 errors; its 71 warnings are
  pre-existing. The bootstrap typecheck is clean.
- **Live check.** I ran the worktree's release on 127.0.0.1:5321 with a throwaway HOME and a scripted local model;
  both are stopped now. All five states showed up in the list with the right labels:
  - running + 2 queued;
  - running + 2 sub-agents;
  - waiting for approval;
  - waiting for form answers;
  - unread.

  The headers said what they should. Answering the form cleared its amber dot, and opening the unread session cleared
  its blue dot.
- **Phone, 390 px.** There is no sideways scroll, and no chip, pill or title wraps or is clipped. I checked this both
  in code and by eye.
  - The first screenshot showed the header pill's chip sliding under the ⋯ button, which is fixed.
  - Known trade-off: upstream already truncates the phone header title to about 4 characters, and the pill costs about
    1 more.
- Screenshots: `~/Desktop/Mac_Phoenix_Shared/UI_Pending_Indicator/sando-*.png` (desktop list / agents / form / approval
  / after-answer, phone drawer and three headers).

### Security (white-hat kit, worst-case model, real CLI, no GPU)

| mode | side effects executed | system prompt leaked |
|---|---|---|
| build | 0/39 (asserted) | 25/39 |
| plan | 0/39 | 25/39 |
| edit | 39/39 (Write is auto-approved, Bash held) | 25/39 |
| **yolo** (the `-p` default; also what `run_agent({engine:'zcode'})` passes) | 39/39 | 25/39 |

The leaks happen because Sando has no output filter. The live run against a real local model was not done; it needs
the GPU lock and a model choice.

### Not done / limits
- A session whose last reply is a form shows the amber dot only once the CLI has a live projection of it. A cold
  stored summary after a CLI restart does not carry it until the session is touched.
- The "Tasks" (scratch workspace) section stays empty after creating a task there. This is the same on the
  untouched release; I checked it side by side. It is not from this branch.
- The running marker is upstream's spinner, not a pulsing dot. I kept it because it was already there.

### Needs Chuck
- Review and merge into `sando`, then `sando-rebuild`.
- Decide on headless safety: should `-p` default to `build`? Or should the Planner's `toolGate.js` model (a taint gate
  after outside content) and an output filter come to Sando, given that `run_agent` uses yolo?
- Optional: a live redteam baseline on a local model. Pick the model; it needs a GPU lock window.

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
