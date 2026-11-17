# Sando spill head + tail and the tool-result pruner (spec)

Port 1 of 5 from the DeepSeek Harness study (`docs/dsh-study-2026-11-17.md` §3, branch `fleet/dsh-study-20261117`),
Planner SAN-4472. Ideas from dsh (MIT) `spill-policy` and `compaction-tool-result-pruner`; no code copied.

## 1. Spill preview shows head and tail

When a tool result is too large and is saved to a file (`<persisted-output>`), the model used to see the first 2,000
chars only. Build and test logs put the error and the summary at the end, so the model had to Read the file or run
the command again. The preview now shows:

```
<persisted-output>
Output too large (101.5KB). Full output saved to: <path>          (unchanged)

Preview (first 2KB and last 1000 bytes):
<head, cut at a line end>
… 98.6KB omitted …
<tail, starting at a line start>
</persisted-output>
```

- Head 2,000 chars (as before); tail 1,000 chars (`PERSISTED_OUTPUT_PREVIEW_TAIL_CHARS`). When what is left after the
  head fits the tail budget, the whole content is shown and there is no marker.
- **Bash** keeps only the first ~30 kB of output inline; the rest is in the output file. A truncated Bash result now
  also carries the file's last 4 kB (`ExecutionStreamResult.tailText` → `BashOutput.stdoutTail`), and the preview takes
  its tail from there, so it is the real end of the log. Bash writes stdout and stderr to one file, so the tail
  includes stderr's end. The gap is then counted in bytes (head and tail come from different sources).
- Generic tools and `TaskOutput` use the same envelope. For them the gap is counted in chars.
- The UI parser (`packages/ui/src/lib/nodeReplToolDisplay.ts`) still matches the envelope.

## 2. Tool-result pruner

Under compaction pressure, old tool results longer than 8,192 chars keep their first 4,096 and last 1,024 chars, with
`… N chars pruned from this old tool result (run the tool again or Read the file for them) …` in between. Before this
change nothing happened to them until full auto-compaction (a model-written summary).

```sh
SANDO_TOOL_RESULT_PRUNER=off sando ...   # upstream behaviour
# unset / on = pruner on; any other value is a startup error (no silent fallback)
```

- **When:** the same trigger as upstream microcompact: the estimated context reaches
  `min(0.9 × autoCompactThreshold, autoCompactThreshold − 2,000)`, or the session has been idle for 60 min. On a 32k
  window with 8k output that is about 9.6k estimated tokens (chars / 3), just below auto-compaction at about 11.6k.
- **What:** results of the compactable tools (Read, Bash, Grep, Glob, WebFetch, WebSearch, Edit, Write, ApplyPatch),
  error results included (the tail keeps the error). Results with images, video or files are left alone. Text blocks
  keep their order; one marker replaces the middle. Surrogate pairs are never split.
- **Never pruned:** the 2 newest tool-result groups (one group = the results of one assistant message). The pruner
  runs before the request, so the newest group has not reached the model yet.
- **Idempotent:** a pruned result is under 8,192 chars, so the next pass leaves it alone. No model call.
- **Fallback:** upstream microcompact (clear old results, keep the 5 newest) is **off by default in Sando** (nothing
  sets `compact.microcompact.enabled`). If an embedder turns it on, it runs after the pruner, and only when pruning did
  not get under the threshold (or when the trigger is idle time). With the pruner off it behaves exactly as upstream.
- **Event:** the `microcompact_boundary` event gets strategy `local_tool_result_prune` and `prunedToolCallIds` (still
  visible, trimmed). `clearedToolCallIds` lists results that were cleared. With the pruner off the payload is
  unchanged (`local_tool_result_clear`, no `prunedToolCallIds`).

## How it is wired

- `core/src/tool/result-persistence-format.ts`: `formatPersistedOutputEnvelope` (head + tail, optional `tailContent`).
- `adapters/src/exec/bash-file-output.ts` `result()`: reads the last 4 kB when truncated; `core/src/tool/handlers/bash-output.ts`
  copies it to `stdoutTail`; `bash-model-content.ts` passes it as `tailContent`.
- `core/src/compact/tool-result-pruner.ts`: env parsing, config, `pruneToolResultContent`.
- `core/src/compact/microcompact.ts`: prune first, then upstream clearing as the fallback.
- `core/src/runtime/methods/microcompact.ts`: `pruner.enabled` from `SANDO_TOOL_RESULT_PRUNER` unless the config sets it.
- `core/src/runtime/helpers/compact.ts`: writes pruned contents back into the runtime entries (as for cleared ones).
- `contracts`: `MicrocompactStrategy.LocalToolResultPrune`, `prunedToolCallIds?`, `ExecutionStreamResult.tailText?`,
  `BashOutput.stdoutTail?`.

## Tests

- `core/test/sando-spill-headtail.test.mjs`: envelope (60k log with the error on the last line, line cuts, counts,
  `tailContent`), pruner primitives, microcompact integration (prune, threshold, off = upstream, fallback, no fallback,
  error results).
- `adapters/test/sando-bash-output-tail.test.mjs`: a truncated Bash result carries the real end of the file.
- `cli/test/sando-spill-headtail.e2e.test.mjs`: the built CLI against a scripted model: a 101 kB Bash log shows its
  last line; on a 32k window old results are pruned and keep their last line, the 2 newest are intact;
  `SANDO_TOOL_RESULT_PRUNER=off` prunes nothing. On the base build the first two fail.

## Not in scope

- The other dsh ports (on-demand MCP loading, OS sandbox, fork prefix reuse, ACP) and the runners-up (per-model
  compaction headroom, escalating repeat reminder).
- Pruning the result of the current step, and changing when full auto-compaction triggers.
