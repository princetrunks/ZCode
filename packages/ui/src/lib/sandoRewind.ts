// Sando: pure helpers for the workbench Rewind dialog (listRewindPoints / rewindToTurn / undoRewind ACKs).
// Kept free of React so they can be unit-tested (test/sandoRewind.test.ts).
import type {
  CommandAck,
  SandoRewindCommandResult,
  SandoRewindPointWire,
  SandoRewindScope,
  SandoRewindUndoInfoWire,
} from "@zcode/shared/zcode-protocol-v4";

export type RewindListOutcome =
  | { ok: true; points: SandoRewindPointWire[]; undo: SandoRewindUndoInfoWire | null }
  | { ok: false; reasonCode: string; message?: string };

export type RewindActionOutcome =
  | { ok: true; result: SandoRewindCommandResult }
  | { ok: false; reasonCode: string; message?: string };

function failure(ack: CommandAck): { ok: false; reasonCode: string; message?: string } {
  return {
    ok: false,
    reasonCode: ack.reasonCode ?? `status.${ack.status}`,
    ...(ack.message ? { message: ack.message } : {}),
  };
}

export function readRewindListAck(ack: CommandAck): RewindListOutcome {
  if (ack.status !== "accepted" && ack.status !== "duplicate") return failure(ack);
  if (ack.result?.type !== "listRewindPoints") return { ok: false, reasonCode: "fault.missingResult" };
  return { ok: true, points: ack.result.points, undo: ack.result.undo };
}

export function readRewindActionAck(ack: CommandAck): RewindActionOutcome {
  if (ack.status !== "accepted" && ack.status !== "duplicate") return failure(ack);
  const result = ack.result;
  if (result?.type !== "rewindToTurn" && result?.type !== "undoRewind") {
    return { ok: false, reasonCode: "fault.missingResult" };
  }
  return { ok: true, result };
}

/** Newest turn first, the order the dialog lists them in. */
export function newestFirst(points: readonly SandoRewindPointWire[]): SandoRewindPointWire[] {
  return [...points].sort((left, right) => right.turn - left.turn);
}

/** What a rewind to `point` with `scope` would cover, for the dialog's summary line. */
export function rewindCoverage(
  point: SandoRewindPointWire,
  scope: SandoRewindScope,
): { fileEdits: number; laterTurns: number; shellCommands: number } {
  return {
    fileEdits: scope === "conversation" ? 0 : point.editCountFromHere,
    laterTurns: scope === "files" ? 0 : point.turn,
    shellCommands: point.shellCommandCountFromHere,
  };
}

/** The result can be retried with force: some files were blocked (changed outside the agent, unreadable checkpoint). */
export function canForce(result: SandoRewindCommandResult | null | undefined): boolean {
  return Boolean(result && !result.applied && result.blockedFiles.length > 0);
}

export const REWIND_IGNORED_REASON_KEYS: Record<string, string> = {
  bash_ignored: "chat.changeSummary.rewindDialog.reason.bashIgnored",
  too_large: "chat.changeSummary.rewindDialog.reason.tooLarge",
  binary: "chat.changeSummary.rewindDialog.reason.binary",
  outside_workspace: "chat.changeSummary.rewindDialog.reason.outsideWorkspace",
  checkpoint_pruned: "chat.changeSummary.rewindDialog.reason.checkpointPruned",
  forced_skip: "chat.changeSummary.rewindDialog.reason.forcedSkip",
  checkpoint_missing: "chat.changeSummary.rewindDialog.reason.checkpointMissing",
  checkpoint_unreadable: "chat.changeSummary.rewindDialog.reason.checkpointUnreadable",
  external_modified: "chat.changeSummary.rewindDialog.reason.externalModified",
  file_read_failed: "chat.changeSummary.rewindDialog.reason.fileReadFailed",
  unsupported_checkpoint: "chat.changeSummary.rewindDialog.reason.unsupportedCheckpoint",
};
