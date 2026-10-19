# Sando roadmap: a harness that competes with the best (2026-10-18)

Goal (Chuck, 2026-10-18): make Sando a coding-agent harness that can stand next to Claude Code, Codex and OpenCode, and bring
genuinely useful features that local models need. Maybe a product later (Harness² is Apache-2.0: keep its NOTICE).

## Already in Sando
- Local-first providers: every forge llama.cpp model, plus cloud when allowed. Headless `sando -p … --json`, web workbench (phone layout).
- Planner plugin: MCP bridge with 51 tools, `/pp-status`, `/pp-ticket`, `/pp-render`, `/forge`, `/pi-mirror`.
- Shell gate in SHADOW mode: CRACK classifies each proposed Bash command as safe / review / never_unattended.
- Inline diagrams (mermaid) and math (`$$`) in the web workbench, the same as Planner Chat, Dive In and /lily.
- **Answerable ```form blocks** (done on branch `fleet/sando-forms-20261018`, 2026-10-18, not yet merged into `sando`): the
  model can end a reply with one JSON ```form (choice / multi / yes-no / scale / text); the web workbench draws chips and boxes
  and sends the answers as the next user message (queued while a turn runs), locks as "Sent" with "Change answers". Same
  contract as the Planner's Chat / Dive In / Lily forms. The # Harness block and the Planner skill teach the model when to use it.
- **Run flags for launchers and Harness²** (same branch, tested end to end against a scripted local server):
  `--model <provider>/<model>` (this run only, validated), `--harness <dir>` (extra AGENTS.md + skills + agents from outside the
  workspace), `--max-turns <n>` (model steps per turn; the last step answers without tools) and `--confine-to-cwd` (file tools
  refuse paths outside the workspace, symlinks resolved). Limits: confinement covers the file tools and the Bash working
  directory, not what a running Bash command or the node REPL touches; `--harness` hooks.json (the proposal's c8) is not done.

- **Native subagents** (merged into `sando` 2026-10-19; spec `SANDO-SUBAGENTS.md`):
  built on upstream's `Agent` tool and `.zcode/agents/*.md` profiles. New: per-call `model` (any configured provider,
  validated before a child starts) and `max_turns`; the step cap is actually enforced (min of call, profile and
  `--max-turns`, default 30); at most 2 children run at once (`ZCODE_SUBAGENT_MAX_PARALLEL`), the rest wait; the parent
  gets only the child's final message cut to 6000 bytes (`ZCODE_SUBAGENT_RESULT_BYTES`, full text in `result.md`) plus
  model / files changed / cap; `--confine-to-cwd` reaches children. The workbench shows each child as a collapsible card.
  Small-context lesson: a `general-purpose` child costs ~28k tokens before it starts; an allowlisted agent ~2k.
- **Checkpoints + `/rewind`** (merged into `sando` 2026-10-19). Every
  successful Edit/Write already stored the file's pre-edit text (upstream). Sando adds the turn model on top:
  `/rewind list`, `/rewind to <turn> [both|files|conversation] [force]` and `/rewind undo` (run it again to redo). The TUI
  shows a turn picker and then a scope picker. The web workbench opens a Rewind dialog when you type `/rewind`.
  - Every rewind saves an undo record: what each file looked like before it, plus the active conversation.
  - Files changed outside the agent block a rewind unless `force` is used.
  - Shell side effects are never undone, and every surface says so.
  - Per-file cap of 2 MiB (`SANDO_CHECKPOINT_MAX_FILE_BYTES`); binaries are skipped.
  - Per-session budget of 256 MiB (`SANDO_CHECKPOINT_SESSION_BUDGET_BYTES`) that prunes the oldest checkpoints first.
  - `--confine-to-cwd` is respected on restore.
  - Limits: edits made by Bash or the node REPL are not checkpointed, so they cannot be rewound.

## Table stakes (what the best harnesses have): status
| Feature | Claude Code / Codex / OpenCode | Sando today | Next step |
|---|---|---|---|
| Subagents / parallel workers | yes | **native** (merged 2026-10-19): `Agent`/`Task` with per-call `model` + `max_turns`, enforced step cap, 2 in parallel, byte-budgeted result + files touched, collapsible card | ship a lean `worker` agent; per-GPU (not per-session) parallel cap |
| Plan mode, checkpoints / rewind | yes | rewind done (merged 2026-10-19; turn list, files / chat / both, undo) | checkpoint Bash-made file changes (shadow-git snapshot), plan mode |
| Hooks, skills, plugins, MCP | yes | yes (plugin) | ship a hooks recipe library |
| Context compaction | yes | upstream | tune for 16k–64k local windows (CRACK voice, Torii 32k) |
| Background tasks that outlive the session | partial | no | tmux/systemd-backed jobs with ntfy on finish |

## Where Sando can lead (local-model specific)
1. **Self-tuning harness (Harness²).** Sando evolves its own prompt, skills and guardrails per model and per codebase, graded by real
   tests (our Sovereign Sandbox `verify.sh`), not vibes. Round 1: the loop works fully local. Round 2: Bonsai executor + Claude
   improver, plus a `sando` substrate (in progress, `~/apps/research/harness2-sovereign`). Client code: local improver only.
2. **Context discipline for small windows.** Teach the harness to keep big file writes and tool output inside 16–32k. Torii Coder fails
   the arena game only because its 32k context fills by turn 13. Includes per-model output caps (CRACK died at a 4k cap, passed at 16k).
3. **Model routing by task.** Pick CRACK / Bonsai / Torii / cloud per step from measured arena results, with the typed `decide` gate.
4. **Forge-aware runtime.** One GPU-job lock, mode switching (`/forge`), and graceful waits when a render evicts the model.
5. **Verified "done".** Built-in "run before done": the agent must execute what it wrote. Background processes are killed by PID,
   never by pattern (Harness² round-1 proposal).
6. **Voice + Planner.** Mic/TTS composer (Lily voice), tickets in and out, status boards, and the same inline diagrams on every surface.

## Product angle (notes, not decided)
"Sando: the coding agent that tunes itself to your models and your codebase, and keeps your code on your machine."
Open questions: packaging, where harness libraries live, how users bring their own tests, licensing of evolved skills.
Confidential work (Honden) stays out of any public material.
