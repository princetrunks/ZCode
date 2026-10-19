# Fleet report: Sando checkpoints + /rewind

## 2026-10-19: branch `fleet/sando-checkpoints-20261019` (pushed to `origin`, not merged)

I worked only in the worktree `~/apps/ZCode-fleet-checkpoints`. I did not touch `~/apps/ZCode`, run `sando-rebuild`,
restart `sando-web.service` or merge anything. The branch is pushed to `origin` (github-zcode), not to `private`.

### What I found first
Upstream ZCode already saves a checkpoint after every successful Edit/Write. The checkpoint holds the file's text from
before the edit, is keyed to the assistant message and turn, and survives `--resume`. Upstream also had a hash-checked,
journaled file restore and a conversation "branch cut". So I built on those pieces instead of adding a second store.
What was missing:
- choosing a turn;
- choosing files, conversation or both;
- undoing a rewind;
- size caps;
- confinement on restore;
- a shell warning;
- a usable web entry point.

### What's done
**`/rewind list`** shows every turn, newest first, with its file edits (and which files) and its shell commands.

**`/rewind to <turn> [both|files|conversation] [force]`** goes back to just before that turn. `both` is the default.
- It undoes every checkpointed edit from that turn to the end, newest first.
- A file the agent created in those turns is deleted.
- If a file changed outside the agent since its last edit, nothing is touched and the response says which file.
- `force` overwrites such files (they can still be recovered with undo) and skips checkpoints that can't be used.
- A files-only rewind tells the model the files changed, so it re-reads them before editing.

**`/rewind undo`** reverses the last rewind; running it again redoes it.
- Every rewind saves an undo record: what each file looked like before, plus the conversation as it was.
- If a file changed after the rewind, undo refuses unless you add `force`.

**Shell commands are never undone.** The list, every rewind response, the TUI picker and the web dialog all say so
whenever shell commands ran in the turns being rewound. Files a shell command made stay where they are (tested).

**Size caps and pruning:**
- A file over 2 MiB (`SANDO_CHECKPOINT_MAX_FILE_BYTES`) or containing a NUL byte is recorded without its content.
  A rewind leaves it alone and says "too large" or "binary"; it is never deleted or truncated.
- Each session has a 256 MiB checkpoint budget (`SANDO_CHECKPOINT_SESSION_BUDGET_BYTES`). Past it, the oldest
  checkpoint files are deleted. A rewind that would need them is refused with a clear "pruned" message unless you
  use `force`. The newest turns stay restorable.

**`--confine-to-cwd`** is respected: rewind and undo never write outside the workspace and list such files as
"outside the workspace".

**TUI:** a bare `/rewind` opens a turn picker, then asks "Files and conversation / Conversation only / Files only".
The prompt shows the shell warning.

**Web workbench:**
- Typing `/rewind` in the composer opens a Rewind dialog instead of sending a prompt. It has turn rows, a scope
  switch, the shell warning, the result text, "Overwrite and rewind anyway" when files are blocked, and
  "Undo last rewind" / "Redo".
- It works through three new v4 commands, `listRewindPoints`, `rewindToTurn` and `undoRewind`, whose replies carry
  the results. Rewinds are refused while a turn is running.
- en-US and zh-CN strings, with 44 px tap targets on phones.
- Screenshots: `~/apps/fleet/logs/sando-rewind-{desktop-open,desktop-applied,desktop-blocked,phone-open,phone-zh}.png`.

**Bug found and fixed on the web path:** after an undo, the live conversation view replayed the earlier rewind's cut
and hid the restored turns again until the CLI process restarted. Cuts from an older branch generation are now dropped
when the conversation view is rebuilt (`cold-event-merge.ts`).

**SANDO-ROADMAP.md** is updated: rewind is done on this branch, and the next steps are Bash-made changes and plan mode.

### How it was checked (all run on the forge; no GPU, no network)
| What | Command | Result |
|---|---|---|
| Core unit tests (caps, prune choice, parser, turn model, list text, confinement) | `pnpm test` in `apps/zcode-cli/packages/core` | 22/22 (7 new) |
| TUI picker through the real command center | `pnpm exec tsx --test apps/zcode-cli/packages/cli/test/sando-rewind-picker.test.mjs` | 3/3 |
| **CLI e2e**: built CLI + scripted local model, one turn per `--resume` run | `…/cli/test/sando-rewind.e2e.test.mjs` | 9/9 |
| **App-server e2e** (the host↔CLI seam the web uses): subscribe, v4 commands, conversation frames | `…/cli/test/sando-rewind-app-server.e2e.test.mjs` | 2/2 |
| Existing run-flags e2e and flag tests | `sando-run-flags.e2e.test.mjs`, `harness-flags.test.mjs` | 5/5, 4/4 |
| UI helpers + every reason/string in both locales | `pnpm exec tsx --test packages/ui/test/sandoRewind.test.ts` | 4/4 |
| Whole-repo typecheck | `pnpm typecheck` | pass |
| Lint | `pnpm lint` | 0 errors; none of the 70 warnings is in a file I changed |

The CLI e2e covers:
- edit → edit → `/rewind to 2`: the files are at turn 2's start, and the **next request sent to the model** carries
  turn 1's marker and not turns 2–3;
- undo, which brings back the files and turns 2–3 in order;
- redo;
- files only;
- conversation only;
- the Bash warning, with the Bash-made file still present;
- a file edited by hand, which blocks the rewind; force then overwrites it and undo brings the hand edit back;
- the size cap;
- confinement;
- pruning;
- bad targets.

### Not done / limits / untested
- **Bash and node REPL edits are not checkpointed** (same as upstream). Rewind can't restore them; it only warns. A
  shadow-git snapshot of the workspace per batch would cover them and is the next step on the roadmap.
- **Granularity is per edit, not per "tool batch".** One checkpoint per Edit/Write is finer than per batch, and a
  rewind replays all of a turn's checkpoints together. The text is captured by the tool itself at edit time.
- **Not tried in the real sando-web.** The dialog was checked in headless Chromium with a scripted backend, and the
  protocol path through a real `sando app-server`, but never in a sando-web build (that needs `sando-rebuild` after
  promotion). Try after promotion: in a session with edits, type `/rewind`, rewind files + chat, then Undo.
- After a files-only rewind in the web, that turn's header can still show its "reverted" file badge after an undo
  (upstream marks the state, I don't clear it). It's cosmetic only.
- A conversation undo after you kept chatting on the rewound branch hides those new turns. They stay in the store and
  come back with a second undo (redo).

### Files the subagents worker also changed (expect merge conflicts)
`apps/zcode-cli/packages/cli/test/fake-openai-server.mjs`:
- Both workers generalized it. Theirs adds `state.handler`; mine adds a function `scenario` that returns one tool call.
- When merging, keep theirs and port `sando-rewind*.e2e` to `handler`: return `{ calls: [call] }`.

`apps/zcode-cli/packages/core/src/runtime/types.ts`, `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts`, `SANDO-ROADMAP.md`:
- These are additive edits in different places, so they should merge cleanly.

I stayed out of tool dispatch. My only change in `tools.ts` is the checkpoint-creation function, which now records
the artifact size and prunes.

### What I need from Chuck
- Review and promote the branch (`dev`/`sando` is your call). After `sando-rebuild`, try `/rewind` in the workbench.
- Decide whether `force` and the 2 MiB / 256 MiB defaults are right for your repos.
