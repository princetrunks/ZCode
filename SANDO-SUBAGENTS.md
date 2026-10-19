# Sando native subagents (spec, 2026-10-19)

Roadmap table-stakes item #1. Sando already had upstream ZCode's `Agent` tool (alias `Task`, hidden), agent profiles from
`~/.zcode/agents/*.md`, `<workspace>/.zcode/agents/*.md` and `<--harness dir>/agents/*.md`, background runs and
`SendMessage`. This spec closes the gaps that matter for forge models running in 16k–64k windows.

## Contract

The parent model calls `Agent` (or `Task`) with:

| field | meaning |
|---|---|
| `description`, `prompt` | as upstream. The child starts fresh, so the prompt must be self-contained. |
| `subagent_type` | an agent definition (`name`, `description`, system prompt body, `tools` allowlist, `disallowedTools`, `model`, `maxTurns`). Default `general-purpose`. |
| `model` (new) | `provider/model` or a bare model id, as `ListModels` prints it. Resolved through the same `ModelCatalogPort` + `resolveModelReference` as the workflow `subagent_model`; unknown, ambiguous or disabled names fail the call (recoverable) with the candidate list. Omitted: the profile's `model`, else the parent's model. |
| `max_turns` (new) | model steps the child may take. The last allowed step runs without tools, so the child always ends with a text answer. |
| `run_in_background` | as upstream. |

### Turn cap
`cap = min(defined values of { max_turns, profile maxTurns, parent --max-turns })`, else `ZCODE_SUBAGENT_MAX_TURNS`, else **30**.
Nothing the model writes can raise a cap the user configured. It is enforced through the runtime's
`maxModelStepsPerTurn` (the `--max-turns` mechanism). Upstream's `maxTurns` config field was never enforced, and it still isn't.

### Result (what the parent sees)
- The child's **final message only**, never its transcript, cut to a byte budget: `ZCODE_SUBAGENT_RESULT_BYTES`, default
  **6000** (about 1.5k tokens). When it is cut, the head is kept with a note, and the full text is written to `result.md` in
  the agent's output dir. The note gives that path, so the parent can `Read` it if it really needs more.
- Then a short footer: `model`, `files_touched` (Write / Edit / NotebookEdit calls that succeeded; at most 20 paths, then
  "+N more"), `turn_cap`, tool uses, duration, `agentId` for `SendMessage`.
- The child is told the budget in its system prompt: lead with the answer, list changed files, no transcript replay.

### Parallel children
At most `ZCODE_SUBAGENT_MAX_PARALLEL` (default **2**) children *execute* at once per parent session, foreground and
background alike. A call over the cap **waits** (FIFO) for a slot rather than failing, and the wait keeps the inactivity watchdog
fed. Cancelling the parent turn also cancels a queued call. All children share the parent's workspace.

**Race risk (documented, not solved):** children can edit the same files at once, and there is no locking. Last write
wins, and an `Edit` whose `old_string` changed under it fails and the child retries. The guidance in the tool description:
give parallel children disjoint files or read-only work. On the forge, llama.cpp slots with `-np 1` serialise requests
anyway, so two children on one local model take turns at the server. Parallelism pays off across different models or
cloud models.

### Confinement
`--confine-to-cwd` is process-wide (`ZCODE_CONFINE_TO_CWD`, checked in `tool/path-policy.ts`), and children run in-process
with the parent's workspace root, so they inherit it. The same limits apply: what a Bash command or the node REPL touches
is not confined.

### Ownership and event order
```mermaid
sequenceDiagram
  participant P as Parent turn (Agent tool handler)
  participant R as Subagent port (runner.ts)
  participant S as Slot gate (per port, cap N)
  participant C as Child AgentRuntime
  P->>P: resolve `model` via ModelCatalogPort (fail fast, before any child exists)
  P->>R: launch(request + modelSelection + maxTurns)
  R->>R: register task, write metadata
  R->>S: acquire (waits FIFO; heartbeat feeds watchdog; abort leaves queue)
  S-->>R: slot
  R->>C: runExploreAgent (own session + context, cap = maxModelStepsPerTurn)
  C-->>R: final text + filesTouched (collected live from ToolCallScheduled/Result)
  R->>S: release (finally, on success / error / abort)
  R->>R: budget the text, write result.md when cut
  R-->>P: AgentCompletedOutput {content, model, filesTouched, turnCap, resultTruncated}
```
The slot is owned by the runner, acquired and released around exactly one `runExploreAgent` call. The model
choice is owned by the tool handler (resolution) and the runtime glue (`runtime/methods/subagent.ts`, which builds the
model). The UI only reads `AgentCompletedOutput`.

## Web workbench
The `Agent` row is a collapsible card. Collapsed, it is the upstream one-line summary (agent type, description, status).
Expanded, it shows a result panel (status, model, turn cap, tool uses, duration, files touched, the returned text), then
the prompt and the child's tool calls. "Open on the right" still opens the full child session.

## Not done
- No per-file locking between parallel children.
- Files changed by Bash are not listed in `files_touched`.
- The cap is per parent session, not per GPU. Two sessions can each run 2 children.
