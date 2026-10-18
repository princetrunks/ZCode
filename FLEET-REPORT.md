# Fleet report: Sando

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
