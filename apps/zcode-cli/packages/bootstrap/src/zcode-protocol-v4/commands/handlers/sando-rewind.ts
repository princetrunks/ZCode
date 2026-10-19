// Sando: web workbench rewind — listRewindPoints / rewindToTurn / undoRewind (see shared sando-rewind-command.ts).
// The runtime does the work (core methods/sando-rewind.ts, the same code as the CLI's /rewind). These handlers only
// refuse while a turn runs, translate the scope word, and keep the projection in step with the conversation.
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
  SandoRewindCommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { RewindScope } from "@zcode/contracts";
import type { SandoRewindResult } from "@zcode/core";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";

export class V4RewindWhileRunningError extends Error {
  readonly reasonCode = "guard.rewindWhileRunning";

  constructor() {
    super("Stop the running turn before rewinding.");
    this.name = "V4RewindWhileRunningError";
  }
}

function assertIdle(record: V4SessionRecordView): void {
  if (record.activeAbortController) throw new V4RewindWhileRunningError();
}

async function toWire(
  record: V4SessionRecordView,
  type: SandoRewindCommandResult["type"],
  result: SandoRewindResult,
): Promise<SandoRewindCommandResult> {
  return {
    type,
    applied: result.applied,
    response: result.response,
    ...(result.turn !== undefined ? { turn: result.turn } : {}),
    restoredFiles: result.restoredFiles,
    skippedFiles: result.skippedFiles,
    blockedFiles: result.blockedFiles,
    conversationRewound: result.conversationRewound,
    shellCommandCount: result.shellCommandCount,
    undo: await record.app.runtime.getRewindUndoInfo(),
  };
}

async function listRewindPoints(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const [points, undo] = await Promise.all([
    record.app.runtime.listRewindPoints(),
    record.app.runtime.getRewindUndoInfo(),
  ]);
  return {
    type: "listRewindPoints",
    points: points.map((point) => ({ ...point, messageId: String(point.messageId) })),
    undo,
  };
}

async function rewindToTurn(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["rewindToTurn"];
  const record = requireRecord(host, envelope.sessionId);
  assertIdle(record);
  const result = await record.app.runtime.rewindToTurn({
    target: payload.targetMessageId,
    scope:
      payload.scope === "files"
        ? RewindScope.Workspace
        : payload.scope === "conversation"
          ? RewindScope.Conversation
          : RewindScope.Both,
    force: payload.force,
    events: [],
    traceContext: record.traceContext,
  });
  // The cut itself reaches the live projection as a RewindTriggered event; this refreshes session state consumers.
  if (result.conversationRewound) await host.afterLegacyStateMutation?.(record, "session_rewound");
  return toWire(record, "rewindToTurn", result);
}

async function undoRewind(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["undoRewind"];
  const record = requireRecord(host, envelope.sessionId);
  assertIdle(record);
  const result = await record.app.runtime.undoLastRewind({
    force: payload.force,
    events: [],
    traceContext: record.traceContext,
  });
  if (result.conversationRewound) {
    await host.afterLegacyStateMutation?.(record, "session_rewind_undone");
    await host.rebuildConversationProjection?.(record.app.sessionId);
  }
  return toWire(record, "undoRewind", result);
}

export const sandoRewindHandlers = { listRewindPoints, rewindToTurn, undoRewind };
