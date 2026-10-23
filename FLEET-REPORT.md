# Fleet report: Sando

## 2026-10-23: invisible-character smuggling filter (branch `fleet/vs-smuggling-20261023`, RD-2628)

I worked only in the worktree `~/apps/ZCode-wt-vs-smuggling`. **Not rebuilt or merged; Chuck promotes Sando.** I did
not touch `~/apps/ZCode`, run `sando-rebuild` or restart anything. The branch is pushed to `origin`.

- **Problem:** Sando had no filter for invisible "smuggling" characters. A run of variation selectors after an emoji
  (one selector per byte) or Unicode tag characters can spell out a whole hidden instruction. A person sees only the
  emoji; the model can read the bytes.
- **Helper:** `scrubInvisible()` in `@zcode/contracts` (`packages/contracts/src/model/invisible-chars.ts`). It uses the
  same rules as the Planner's `invisibleChars.js`:
  - Kept: a single FE0E/FE0F after an emoji (so ❤️, ☺︎, 1️⃣ and 🏳️‍🌈 are unchanged) and subdivision flags such as
    England's.
  - Removed: every other selector and every other tag character.
  - Flagged as smuggling: any tag character outside a flag, a run of 3 or more selectors, or 4 or more stray selectors
    in one text.
- **Where it is wired (one main choke point):** `buildProviderRequestMessages` in `core`. This is the function that
  turns history into the messages for every model request: the main turn (including `sando -p` headless), subagents,
  compaction, the memory agent and verification.
  - It covers user prompts, pasted or attached files (`prompt_attachment`), context entries, and all tool results:
    Read, Bash, WebFetch, WebSearch and MCP.
  - Only the copy sent to the model is cleaned. Saved history keeps the original, so rewind, fork and the UI are
    unchanged.
  - Assistant messages are left alone, so signed reasoning is replayed byte-identical. Images and other binary media
    are not touched.
  - When a tool result or attachment contained smuggling, it starts with a visible line:
    `[N hidden characters removed: variation-selector smuggling]`.
  - The runtime logs one `[sando-invisible]` warn line per finding. It holds counts only, never the hidden text, and
    is not repeated when the same history is sent again.
  - Two side calls skip that function, so each is cleaned where it is built:
    - the WebFetch extraction prompt (the page goes to a helper model first; the note is carried onto its answer);
    - the session-title generator.
- **Tests:**
  - New contracts unit tests: 7/7. Real emoji, flags and CJK text are unchanged; runs and tags are removed; the
    result is idempotent.
  - New core live-path tests: 6/6. The kit cases vs-smuggle-01 (user), 02 (page, both as a tool result and as the
    WebFetch extraction prompt) and 03 (attachment) are copied into `core/test/fixtures` together with the
    encoder/decoder. In every case `vsDecodeAll` finds nothing, "Banana bread" and "milk" survive, and the note and
    log line appear. No model was called.
  - Core suite: 43/43. Typecheck is clean for contracts, core, adapters and bootstrap. `architecture:check` is OK.
  - oxlint is clean on every changed file. The package-wide `pnpm lint` still fails on old `max-lines` errors in
    files I did not touch (`model/index.ts`, `session-fork.ts`, …).
  - To run the tests I ran `pnpm install --offline --ignore-scripts` and built the library packages with tsc inside
    the worktree. The CLI bundle (`zcode.cjs`) was not built.
- **Not covered or not tested:**
  - A live `sando -p` run against a model.
  - The memory-agent loop's own tool messages. They read local memory files, and their requests still pass through
    the projection.
  - Text sent inside a base64 `file` data URL (for example a text/plain file sent as raw file data).
  - A user prompt with smuggling is cleaned and logged, but gets no visible note (only tool results and attachments
    do).
  - Duplicate logs are suppressed by a key built from counts and length. Two different messages with identical
    counts in one process are logged only once.

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
