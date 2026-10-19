# Fleet report: Sando native subagents

## 2026-10-19: native subagents (branch `fleet/sando-subagents-20261019`)

I worked only in the worktree `~/apps/ZCode-fleet-subagents` (branch cut from `sando` @ 38e24fb). I did not touch
`~/apps/ZCode`, run `sando-rebuild`, restart `sando-web.service` or merge anything. The branch is pushed to `origin`
(github-zcode), not to `private`, which is the remote `sando-rebuild` pulls from.

### The main finding
Upstream ZCode already had most of a subagent system:
- an `Agent` tool, with a hidden Claude-Code-compatible `Task` alias;
- agent definitions in `~/.zcode/agents/*.md`, `<workspace>/.zcode/agents/*.md` and `<--harness>/agents/*.md`
  (name, description, system prompt, tools allowlist, model, maxTurns);
- background runs, `SendMessage`, and a child-session side pane in the workbench.

So I did not add a second tool. I closed the gaps the brief asked for. The spec is `SANDO-SUBAGENTS.md`.

### What's done
1. **Own model per child.** The `Agent` tool takes `model` (`provider/model` or a bare id, any provider in
   `provider_config`). It goes through the same resolver the workflows use, before any child starts. An unknown,
   ambiguous or disabled name fails the call and lists the candidates. Omitted, the child uses the agent file's
   model, else the parent's.
2. **Turn cap that actually works.** `max_turns` on the call. The cap is the smallest of the call, the agent file's
   `maxTurns` and the parent's `--max-turns`; otherwise 30 (`ZCODE_SUBAGENT_MAX_TURNS`). The last step runs without
   tools, so a child always ends with an answer. Upstream's `maxTurns` was never enforced.
3. **Compact result.** The parent gets only the child's final message, cut to 6000 bytes
   (`ZCODE_SUBAGENT_RESULT_BYTES`); when cut, the full text goes to `result.md`. Then a short footer: model, files
   changed (successful Write / Edit / NotebookEdit), step cap, tool uses, time. Children are told the budget.
4. **Parallel cap.** At most 2 children run at once (`ZCODE_SUBAGENT_MAX_PARALLEL`); extra calls wait their turn.
   Children share the workspace with no file locking. The tool description tells the model to give parallel children
   different files or read-only work.
5. **`--confine-to-cwd` reaches children.** Tested end to end.
6. **Fixed on the way:** an agent file with `model: provider/model` and no `thoughtLevel` failed ("Reasoning level is
   required") for any model with reasoning levels. It now gets the registry default.
7. **Web workbench.** The Agent row is now a collapsible card. Expanded, it shows status, model, step cap, tool uses,
   time, files changed and the returned text. "Open in side pane" (the full child session) is a button inside the card.
8. `SANDO-ROADMAP.md` and `SANDO-SUBAGENTS.md` are updated.

### How it was checked
- **Core:** 9 new unit tests (`core/test/sando-subagents.test.mjs`), 24/24 with the old ones. They drive the real port
  and Agent handler with a fake child: parallel cap and queue order, cancel while queued, result budget (UTF-8 safe),
  files touched, model resolution errors, cap rules.
- **End to end:** 7 new tests (`cli/test/sando-subagents.e2e.test.mjs`), 16/16 with the old CLI tests. They run the
  built CLI against the scripted local server; no GPU, no network. They check:
  - the child ran on `model-b` while the parent stayed on `model-a`;
  - the child never saw the parent's prompt and had no Agent/Task tool;
  - the parent got the answer plus `model / files_touched / turn_cap`, but not the child's tool calls;
  - `max_turns 2` gave exactly 2 child steps, the last without tools;
  - three parallel children peaked at 2 in flight (control run with cap 3: peak 3);
  - a 24 KB answer was cut to the budget, with the full text in `result.md`;
  - confinement refused a child's `Read /etc/hostname`;
  - an agent file set the system prompt, tools (Read, Grep), model and cap;
  - an unknown model failed with candidates and started no child.
- **Workbench:** 5 unit tests for the result parser. The card was rendered in headless Chromium at 1100 px and 390 px
  on a throwaway page using the real `ToolCallBlock` (removed afterwards). Screenshots:
  `~/apps/fleet/logs/sando-subagent-card-{desktop,phone}-{collapsed,open}.png`.
- `pnpm typecheck` (root) passes. oxlint and oxfmt are clean on every file I changed. The package-level `pnpm lint` in
  `apps/zcode-cli` was already failing before this work on files I did not touch (max-lines in `steering.ts`,
  `session-fork.ts`, `prompt-command.ts`…).
- **Real model: Bonsai 2 27B on :8100.** It was already running in jarvis mode; I took the GPU-job lock (waited about
  1 h and later 2.4 h behind Harness² round 3, never forced) and did not touch forge-mode. Two runs of the built CLI,
  each with a throwaway HOME, a copy of the forge's `forge-bonsai2` provider entry, and
  `--max-turns 8 --confine-to-cwd`. The prompt: delegate "fix add() in src/math.js" to a subagent with `max_turns 6`,
  and don't edit files yourself. **Both passed:** 65 s, exit 0, `add(2,3) = 5`. The parent answered "The subagent
  changed `src/math.js` … It ran on the model `forge-bonsai2/bonsai2-27b`".
  - Run 2 kept its HOME so I could check the model I/O logs. The parent made exactly one tool call (`Agent`), then
    answered.
  - The child ran in its own session (`sess_subagent_agent_…`, 23 tools offered) and did `Read` → `Edit` → answer.
  - The parent received the footer `model: forge-bonsai2/bonsai2-27b`, `files_touched: src/math.js`, `turn_cap: 6`,
    `tool_uses: 2`, `duration_ms: 29497`, `subagent_tokens: 82701`.
  - That last number is the small-model problem below, seen on a real model: three child steps cost ~83k tokens,
    mostly the inherited tool schemas.
  - Logs: `~/apps/fleet/logs/sando-subagents-bonsai{,2}.log`. The temp HOMEs are deleted.

### Important for small models
A `general-purpose` child costs about **111 KB (~28k tokens)** before doing anything, because it inherits all 23 tools
(workflow tools included). That is nearly what the parent costs (129 KB). A child from an agent file with
`tools: Read, Grep` costs **7.6 KB (~2k tokens)**. On 16–32k forge models, use an allowlisted agent; the spec has a
`worker.md` recipe.

### Not done / limits / untested
- **No file locking** between parallel children; last write wins. Files changed by Bash are not listed.
- **The cap is per parent session**, not per GPU. Background children hold their slots, so a foreground call can queue
  behind them.
- **`SendMessage` resume** of a stopped child goes back to the profile / parent model, not a per-call `model`. This is
  from reading the code; not tested.
- **Not tested inside the live workbench** with a real session (that needs a sando-web build). The card was checked
  with the real renderer and made-up results.
- **Behaviour change in the UI:** clicking an Agent row used to open the side pane; now it expands the card, and the
  side pane is a button inside (same test id). Upstream desktop e2e specs that click the row would need updating; I
  did not run them.
- `packages/ui/test/nonCliAcpRetirement.test.ts` fails under `tsx`. It fails the same way without my changes (tsx
  cannot resolve the `@/` alias in an upstream file).

### Merge warning: files the checkpoints branch also touched
`fleet/sando-checkpoints-20261019` (7 commits by the end of my run) and this branch both change 5 files. A trial merge
(`git merge-tree`, nothing written) gives:
- **Clean auto-merges:** `core/src/runtime/types.ts` and the en-US / zh-CN locales.
- **`SANDO-ROADMAP.md` conflicts.** Both branches edit the "Already in Sando" list and the subagents/checkpoints table
  rows. Keep both entries.
- **`cli/test/fake-openai-server.mjs` conflicts.** Both of us extended it. Theirs: a function scenario returning one
  `{ name, args }` call. Mine: a per-request `handler` with several calls, a delay and an in-flight count. My version
  now also accepts their function-scenario contract (checked with a direct probe), so take **this branch's** copy of
  that file. I did not run their e2e tests against it.

I did not touch session persistence or checkpoint code. My other changed files: `core/src/subagent/runner.ts` (plus new
`slot-gate.ts`, `result-budget.ts`, `files-touched.ts`), `core/src/runtime/methods/subagent.ts`,
`core/src/tool/handlers/agent.ts`, `contracts/src/tools/agent.ts`, `contracts/src/interfaces/subagent.port.ts`,
`bootstrap/src/app/runtime-config.ts`, and `packages/ui/.../renderers/agent.tsx` (plus new `agentResultSection.tsx` and
`lib/agentResultSummary.ts`).

### What Chuck needs to decide
- **Promotion:** review and merge into `sando`, then push to `private` and run `sando-rebuild`.
- **The UI change:** is "click expands the card, side pane is a button inside" right for the phone too?
- **A lean default:** should Sando ship a built-in `worker` agent (allowlisted tools) and point the tool description at
  it, so local models stop paying ~28k tokens per child?
