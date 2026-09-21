---
name: pp-ticket
description: Work a Planner ticket in this repo — fetch it, implement on a branch, note the result back. Usage: /pp-ticket PP-123
---
Ticket: $ARGUMENTS
1. `get_ticket_by_prefix` for the ticket; read the notes and attachments list.
2. Restate the acceptance criteria in two lines, then implement in this repository on a branch named after the ticket.
3. Run the project's tests; do not commit if they fail.
4. `add_note` on the ticket with what changed, the branch name and how to verify; `update_task_status` to `review`.
