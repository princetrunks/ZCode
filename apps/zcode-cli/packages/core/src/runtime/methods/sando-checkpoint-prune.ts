// Sando: keep one session's checkpoint artifacts within a byte budget (see helpers/sando-checkpoint-limits.ts).
// Pruned checkpoint ids are remembered as session entries, so a later rewind can say "pruned" instead of a bare
// read error, and the budget is not recounted against artifacts that are already gone.
import { RewindScope, SessionEventType, parseCheckpointCreatedPayload, traceContextToLogContext } from "../deps.js";
import type { CheckpointCreatedPayload, TraceContext } from "../deps.js";
import {
  checkpointSessionBudgetBytes,
  selectCheckpointsToPrune,
} from "../helpers/sando-checkpoint-limits.js";
import type { AgentRuntimeInternal } from "../internal.js";

export const SESSION_ENTRY_SANDO_CHECKPOINT_PRUNED = "sando/checkpoint_pruned";

const prunedCache = new WeakMap<AgentRuntimeInternal, Set<string>>();

export async function loadPrunedCheckpointIds(runtime: AgentRuntimeInternal): Promise<Set<string>> {
  const cached = prunedCache.get(runtime);
  if (cached) return cached;
  const ids = new Set<string>();
  try {
    const entries =
      (await runtime.sessionStore?.sessionEntries?.({
        sessionID: runtime.sessionId,
        type: SESSION_ENTRY_SANDO_CHECKPOINT_PRUNED,
      })) ?? [];
    for (const entry of entries) {
      const checkpointId = (entry.data as { checkpointId?: unknown } | undefined)?.checkpointId;
      if (typeof checkpointId === "string") ids.add(checkpointId);
    }
  } catch {
    // An unreadable entry table only means pruned checkpoints show up as unreadable rather than "pruned".
  }
  prunedCache.set(runtime, ids);
  return ids;
}

export async function pruneCheckpointArtifacts(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  budgetBytes: number = checkpointSessionBudgetBytes(),
): Promise<string[]> {
  const store = runtime.artifactStore;
  if (!store?.deleteToolResultArtifact) return [];

  const pruned = await loadPrunedCheckpointIds(runtime);
  const checkpoints: CheckpointCreatedPayload[] = [];
  for (const event of await runtime.eventStore.getEvents(runtime.sessionId)) {
    if (event.type !== SessionEventType.CheckpointCreated) continue;
    try {
      const checkpoint = parseCheckpointCreatedPayload(event.payload);
      if (checkpoint.scope === RewindScope.Conversation) continue;
      if (!pruned.has(checkpoint.checkpointId)) checkpoints.push(checkpoint);
    } catch {
      // ignore malformed payloads, same as the rewind readers
    }
  }

  const victims = selectCheckpointsToPrune(checkpoints, budgetBytes);
  const prunedNow: string[] = [];
  for (const checkpoint of victims) {
    try {
      await store.deleteToolResultArtifact({ uri: checkpoint.snapshotRef, trace: traceContext });
      pruned.add(checkpoint.checkpointId);
      prunedNow.push(checkpoint.checkpointId);
      const now = Date.now();
      await runtime.sessionStore?.saveSessionEntry?.({
        id: `sando-checkpoint-pruned:${checkpoint.checkpointId}`,
        sessionID: runtime.sessionId,
        type: SESSION_ENTRY_SANDO_CHECKPOINT_PRUNED,
        time: { created: now, updated: now },
        touchSession: false,
        data: { checkpointId: checkpoint.checkpointId, artifactBytes: checkpoint.artifactBytes },
      });
    } catch (error) {
      runtime.logger?.warn("Checkpoint prune failed", {
        ...traceContextToLogContext(traceContext),
        checkpointId: checkpoint.checkpointId,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "checkpoint.prune.failed",
        module: "core.runtime",
        status: "failed",
      });
    }
  }
  if (prunedNow.length > 0) {
    runtime.logger?.info("Pruned old checkpoint artifacts over the session budget", {
      ...traceContextToLogContext(traceContext),
      budgetBytes,
      event: "checkpoint.pruned",
      module: "core.runtime",
      prunedCount: prunedNow.length,
      status: "completed",
    });
  }
  return prunedNow;
}
