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
