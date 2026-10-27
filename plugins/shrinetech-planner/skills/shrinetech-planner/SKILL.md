---
name: shrinetech-planner
description: How to use the ShrineTech Project Planner tools (mcp shrinetech-planner) from Sando — projects, tasks, time logs, and the Overseer's render / decide / train_lora / run_agent tools — and the house rules that go with them.
---

## What the server is

`shrinetech-planner` is the Project Planner's MCP endpoint. Two families of tools:

- **Planner data**: `list_projects`, `list_tasks`, `get_task`, `create_task`, `update_task`, `update_task_status`, `queue_task`
  (hands a task to NanoClaw), `log_time`, `list_work_logs`, `add_note`, `search_tasks`, `get_priorities`, `get_project_stats`,
  `list_invoices`, `git_status`, `list_git_branches`, `get_ticket_by_prefix` (e.g. `PP-468`), sprites (`sprite_send_message`,
  `sprite_list_messages`), Oanda quotes/OHLC/account (read), plus resources and prompts.
- **Overseer tools** (prefixed `[Overseer]` in their descriptions): `run_agent` (a coding agent in an isolated worktree —
  engines `claude`, `local`, `zcode`, `kimi`, `codex`), `render_h3_scene` / `render_h3_take` (MiniMax-H3 video of Danielle or
  Charlie on the forge), `generate_image` (stills: `anime`, `realistic`, `krea2`, `qwen21` with reference images and stacked
  `loras`), `decide` (Laya typed decisions: choice / score, CPU, ~0.3 s), `train_lora` (LoRA Studio), `annotate_media`,
  `list_tools`, `log_work`, `get_calendar`.

## House rules (these are the user's standing instructions — follow them)

1. **Tickets come from the Planner.** Before working a ticket, `get_ticket_by_prefix` or `get_task` for the real title, notes and
   status; when done, `update_task_status` and `add_note` with what changed and the branch name.
2. **Never start training on your own.** `train_lora` only when the user says train (the GPU is shared with renders and
   client work). `action: "list"` and `"status"` are always fine.
3. **Never favorite media.** `annotate_media` with a note is welcome; `favorite: true` only when the user says so.
4. **Renders pause the forge coder.** A render evicts the resident model for minutes; say so, and never queue two at once.
5. **Client projects stay on local models.** `run_agent` on a client project uses `local` or `zcode`, never a cloud engine,
   unless the user explicitly allows cloud.
6. **Qwen-Image 2.1 is research-licensed.** Use `qwen21` stills for personal work and H3 plates, not for anything sold.
7. **Log time with a generic description** for client work (`log_time`); the detail stays in the ticket.
8. **Say what happened, not what will happen.** If a tool was not called, do not claim the work started.

## Patterns

- Triage: `decide` with a `choice` question to pick an engine/tier, then act.
- Plan → build: `get_task` → `run_agent` (engine `zcode` for local, `claude` for cloud when allowed) → `add_note` + `update_task_status`.
- Danielle stills (recipe of record): `generate_image` style `qwen21`, prompt starting with the H3 descriptor prose, `loras:
  ["danielle_qi21_v6b.safetensors:1.0"]`, one reference sheet in `reference_images` (`ref_d9_3_512.jpg`).

## Pi 5 GitHub mirror

"Back up / mirror / sync the repos to the Pi" means the forge command `pi-mirror` (shell, not an MCP tool): `pi-mirror status` first,
then `pi-mirror run` (refreshes the repo list from GitHub, starts the mirror on theAIRaspPi in the background), `pi-mirror log` to check. "Fork X and back it up" = `pi-mirror fork <github url>`.
Never delete, reset or push anything in the mirror. Same as the `/pi-mirror` command.

## Diagrams and math

Sando's web workbench and the Planner's Chat / Lily pages render a ```mermaid fence as a diagram and `$…$` / `$$…$$` as KaTeX.
When a reply explains architecture, a flow or a sequence (forge modes, request paths, agent hand-offs), add one small
```mermaid diagram (`flowchart TD` or `sequenceDiagram`) next to the prose; write formulas as `$$…$$`. Voice replies drop
these blocks before TTS, so the spoken text must still make sense without them.

## Forms (several decisions at once)

When a reply needs several real decisions from the user, it may end with one ```form fence holding a JSON spec
(`{"title", "intro"?, "fields": [{"id", "label", "type": "choice|multi|yesno|scale|text", "options"?, "required"?, "note"?, "other"?}]}`).
Sando's web workbench and the Planner's Chat / Dive In / Lily draw it as buttons and boxes; the answers come back as the next
user message (`Form answers: <title>` + one line per question + `answers-json: {…}`). Keep it to genuine decisions (not a single
yes/no, not things you can decide yourself), at most one form per reply, and never in voice replies.

## Charts, flows and audio (same blocks as the Planner, 2026-10-27)

Sando, the Planner's Chat and Lily draw these fences (one JSON object each; the source is always one tap away):
- ```chart: `{"type":"line|bar|area|scatter|donut","title","unit"?,"x":[labels],"series":[{"name","data":[numbers]}]}`. Use it when
  numbers over time or a comparison read better as a picture. Scatter data is `[[x,y],…]` and allows at most 3 series. A donut is one
  series of positive parts (6 at most; the rest fold into Other). State the key numbers in the prose too, never invent data to fill a
  chart, and use no chart for one or two numbers.
- ```flow: `{"title","steps":[{"label","status":"done|active|blocked|todo","note"?}]}`. It draws a status card for progress through
  steps (a rollout, a pipeline). Use ```mermaid for structure (who calls what).
- ```audio: `{"src":"<folder>/<file>.wav","label"}`. It plays a file from the Planner's allowlisted shared folders (today
  `filler_lora_ab`, i.e. ~/Desktop/Mac_Phoenix_Shared/filler_lora_ab/). It plays only in a browser logged in to the Planner, and never
  from a web URL. A ```abtest A/B listening block (`{"title","question","pairs":[{"id","a","b","prompt"?,"note"?}]}`) is answerable in
  the Planner's Chat and Lily only; Sando shows its source.
Never read a chart, flow or clip aloud. In a voice reply say "I put a chart in the chat".
