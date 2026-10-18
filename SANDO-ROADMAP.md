# Sando roadmap: a harness that competes with the best (2026-10-18)

Goal (Chuck, 2026-10-18): make Sando a coding-agent harness that can stand next to Claude Code, Codex and OpenCode, and bring
genuinely useful features that local models need. Maybe a product later (Harness² is Apache-2.0: keep its NOTICE).

## Already in Sando
- Local-first providers: every forge llama.cpp model, plus cloud when allowed. Headless `sando -p … --json`, web workbench (phone layout).
- Planner plugin: MCP bridge with 51 tools, `/pp-status`, `/pp-ticket`, `/pp-render`, `/forge`, `/pi-mirror`.
- Shell gate in SHADOW mode: CRACK classifies each proposed Bash command as safe / review / never_unattended.
- Inline diagrams (mermaid) and math (`$$`) in the web workbench, the same as Planner Chat, Dive In and /lily.

## Table stakes (what the best harnesses have): status
| Feature | Claude Code / Codex / OpenCode | Sando today | Next step |
|---|---|---|---|
| Subagents / parallel workers | yes | via Planner `run_agent` | native subagents with their own model and context |
| Plan mode, checkpoints / rewind | yes | partial | checkpoint per tool batch, `/rewind` |
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
