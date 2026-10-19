// ============================================================
// Sando: checkpoint size caps
// ============================================================
// Every successful Edit/Write stores the file's pre-edit (and post-edit) text as a checkpoint artifact. Big files and
// binaries would make that store grow without bound, so:
// - a file whose before or after text is over the per-file cap, or that looks binary (contains NUL), is recorded
//   with `omitted` and no content: rewind lists it as "not restorable" and leaves it alone;
// - the checkpoint artifacts of one session share a byte budget; past it the oldest artifacts are deleted, and
//   rewinding to a turn that needs them says so (the newest turns stay restorable).

export const CHECKPOINT_MAX_FILE_BYTES_ENV = "SANDO_CHECKPOINT_MAX_FILE_BYTES";
export const CHECKPOINT_SESSION_BUDGET_BYTES_ENV = "SANDO_CHECKPOINT_SESSION_BUDGET_BYTES";

export const DEFAULT_CHECKPOINT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_CHECKPOINT_SESSION_BUDGET_BYTES = 256 * 1024 * 1024;

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function checkpointMaxFileBytes(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(env[CHECKPOINT_MAX_FILE_BYTES_ENV], DEFAULT_CHECKPOINT_MAX_FILE_BYTES);
}

export function checkpointSessionBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveInt(
    env[CHECKPOINT_SESSION_BUDGET_BYTES_ENV],
    DEFAULT_CHECKPOINT_SESSION_BUDGET_BYTES,
  );
}

export type CheckpointOmittedReason = "too_large" | "binary";

/** Why the content of a checkpointed file is not stored, or undefined when it is stored. */
export function checkpointOmittedReason(
  contents: ReadonlyArray<string | null | undefined>,
  maxFileBytes: number = checkpointMaxFileBytes(),
): CheckpointOmittedReason | undefined {
  for (const content of contents) {
    if (typeof content !== "string") continue;
    if (content.includes("\u0000")) return "binary";
  }
  for (const content of contents) {
    if (typeof content !== "string") continue;
    // length is a cheap lower bound of the UTF-8 size; only measure exactly when it could matter.
    if (content.length > maxFileBytes || Buffer.byteLength(content, "utf8") > maxFileBytes) {
      return "too_large";
    }
  }
  return undefined;
}

/**
 * Oldest-first list of checkpoint artifacts to delete so the session's total stays within budget.
 * `checkpoints` must be in creation order; entries without a known size count as 0 and are never chosen.
 */
export function selectCheckpointsToPrune<T extends { artifactBytes?: number }>(
  checkpoints: readonly T[],
  budgetBytes: number,
): T[] {
  let total = checkpoints.reduce((sum, checkpoint) => sum + (checkpoint.artifactBytes ?? 0), 0);
  const prune: T[] = [];
  // Never prune the newest checkpoint: it is the one that was just written.
  for (const checkpoint of checkpoints.slice(0, -1)) {
    if (total <= budgetBytes) break;
    if (!checkpoint.artifactBytes) continue;
    prune.push(checkpoint);
    total -= checkpoint.artifactBytes;
  }
  return prune;
}
