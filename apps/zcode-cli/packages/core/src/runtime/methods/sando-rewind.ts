/* eslint-disable max-lines -- list / to / undo share the turn model, the undo record and the response wording. */
// ============================================================
// Sando: /rewind list | to <turn> [both|files|conversation] [force] | undo
// ============================================================
// Builds on the upstream pieces instead of a second store:
// - checkpoints: one artifact per successful Edit/Write with the file's pre-edit text (tools.ts), keyed to the
//   assistant message, persisted as session entries so they survive resume;
// - files: applyWorkspaceFileRewind (hash-checked plan + write journal with compensation) across every checkpoint
//   from the chosen turn to the end of the branch;
// - conversation: the append-only branch cut (rewindConversationToMessage).
// What Sando adds is the turn model, the scope choice, and an undo record per rewind: the journal of what every file
// looked like before the rewind plus the active message list. `/rewind undo` applies that record and saves its own,
// so running it again redoes. Shell (Bash) side effects are never undone; every response says so when they ran.
//
// Order of one `/rewind to`:
//   preview file plan ─(unsafe & !force)→ refuse, nothing touched
//        │
//   apply files (journal) ── commit gate ──> conversation branch cut ──(fails)→ journal restores the files
//        │
//   save undo record (artifact + session entry) → notice to the model (files-only) → response
import { createHash } from "node:crypto";
import {
  RewindScope,
  RewindStrategy,
  SessionEventType,
  activeSessionMessages,
  createMessageId,
  isFileSystemPortError,
  parseCheckpointCreatedPayload,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CheckpointCreatedPayload,
  MessageId,
  MessageWithParts,
  SessionEntryInfo,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import { sanitizeSystemReminderBody } from "../../system-reminder/source.js";
import { isPathAllowedByConfinement } from "../../tool/path-policy.js";
import { previewTextFromMessage } from "../helpers/index.js";
import type {
  SandoRewindPoint,
  SandoRewindResult,
  SandoRewindUndoInfo,
  WorkspaceFileRewindIgnoredFile,
  WorkspaceFileRewindPriorState,
  WorkspaceFileRewindUnsafeFile,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { rebuildConversationDerivedState } from "./rewind-message.js";

export const SESSION_ENTRY_SANDO_REWIND_UNDO = "sando/rewind_undo";
const UNDO_ARTIFACT_CONTENT_TYPE = "application/json";

interface RewindUndoRecord {
  version: 1;
  undoId: string;
  createdAt: number;
  kind: "rewind" | "undo";
  label: string;
  /** Each path once, with its content before the rewind (exists=false → the rewind created it). */
  files: WorkspaceFileRewindPriorState[];
  /** sha256 of what the rewind left in each file; undo refuses (without force) when the file changed since. */
  leftHashes: Record<string, string | null>;
  /** Active conversation branch before the rewind, oldest first. Absent → the rewind did not touch the conversation. */
  conversation?: { activeMessageIds: MessageId[] };
}

interface RewindUndoEntryData {
  undoId: string;
  artifactUri: string;
  createdAt: number;
  kind: "rewind" | "undo";
  label: string;
  consumed: boolean;
}

// ------------------------------------------------------------
// Turn model
// ------------------------------------------------------------

function isRealUserPrompt(message: MessageWithParts): boolean {
  const info = message.info;
  if (info.role !== "user") return false;
  return !info.summary && !info.synthetic && !info.source;
}

const EDIT_TOOL_NAMES = new Set(["write", "edit", "multiedit", "applypatch", "notebookedit"]);

function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isShellToolName(name: string): boolean {
  const normalized = normalizedToolName(name);
  return (
    normalized === "bash" ||
    normalized === "shell" ||
    normalized.includes("terminal") ||
    normalized.endsWith("shell")
  );
}

function toolParts(message: MessageWithParts) {
  return message.parts.flatMap((part) => (part.type === "tool" ? [part] : []));
}

async function readActiveMessages(runtime: AgentRuntimeInternal): Promise<MessageWithParts[]> {
  if (!runtime.sessionStore) return [];
  const session = await runtime.sessionStore.getSession(runtime.sessionId);
  const persisted = await runtime.sessionStore.messages({ sessionID: runtime.sessionId });
  return activeSessionMessages(persisted, {
    branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session?.revert?.createdMessageID,
    rewindKeptMessageIds: session?.revert?.keptMessageIDs,
    rewindTargetMessageId: session?.revert?.targetMessageID,
  });
}

function checkpointMessageIds(checkpoint: CheckpointCreatedPayload): string[] {
  return [checkpoint.messageId, checkpoint.targetMessageId, checkpoint.toolMessageId].flatMap(
    (id) => (id ? [String(id)] : []),
  );
}

export function buildRewindPoints(
  messages: readonly MessageWithParts[],
  checkpoints: readonly CheckpointCreatedPayload[],
): SandoRewindPoint[] {
  const promptIndexes = messages.flatMap((message, index) =>
    isRealUserPrompt(message) ? [index] : [],
  );
  // Each checkpoint counts once, in the turn of the first message it names (it can name the assistant message and
  // the tool-result message, which sit in the same turn).
  const turnIndexByMessageId = new Map<string, number>();
  promptIndexes.forEach((start, position) => {
    const end = promptIndexes[position + 1] ?? messages.length;
    for (const message of messages.slice(start, end)) {
      turnIndexByMessageId.set(String(message.info.id), position);
    }
  });
  const editCountByTurnIndex = new Map<number, number>();
  for (const checkpoint of checkpoints) {
    const position = checkpointMessageIds(checkpoint)
      .map((id) => turnIndexByMessageId.get(id))
      .find((value) => value !== undefined);
    if (position === undefined) continue;
    editCountByTurnIndex.set(position, (editCountByTurnIndex.get(position) ?? 0) + 1);
  }

  const points = promptIndexes.map((start, position) => {
    const end = promptIndexes[position + 1] ?? messages.length;
    const segment = messages.slice(start, end);
    const editCount = editCountByTurnIndex.get(position) ?? 0;
    let shellCommandCount = 0;
    const editedFiles = new Set<string>();
    for (const message of segment) {
      for (const part of toolParts(message)) {
        if (isShellToolName(part.tool)) {
          shellCommandCount += 1;
          continue;
        }
        if (!EDIT_TOOL_NAMES.has(normalizedToolName(part.tool))) continue;
        const input = part.state.input as Record<string, unknown>;
        const path = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
        if (typeof path === "string" && path.length > 0) editedFiles.add(path);
      }
    }
    const prompt = messages[start]!;
    return {
      turn: position + 1,
      messageId: prompt.info.id as MessageId,
      preview: previewTextFromMessage(prompt) ?? "(no text)",
      createdAt: prompt.info.time.created,
      editCount,
      editedFiles: [...editedFiles],
      shellCommandCount,
      editCountFromHere: 0,
      shellCommandCountFromHere: 0,
    } satisfies SandoRewindPoint;
  });

  let edits = 0;
  let shells = 0;
  for (const point of [...points].reverse()) {
    edits += point.editCount;
    shells += point.shellCommandCount;
    point.editCountFromHere = edits;
    point.shellCommandCountFromHere = shells;
  }
  return points;
}

async function workspaceCheckpoints(
  runtime: AgentRuntimeInternal,
): Promise<CheckpointCreatedPayload[]> {
  const out: CheckpointCreatedPayload[] = [];
  for (const event of await runtime.eventStore.getEvents(runtime.sessionId)) {
    if (event.type !== SessionEventType.CheckpointCreated) continue;
    try {
      const checkpoint = parseCheckpointCreatedPayload(event.payload);
      if (checkpoint.scope !== RewindScope.Conversation) out.push(checkpoint);
    } catch {
      // malformed payloads are skipped everywhere else too
    }
  }
  return out;
}

export async function listRewindPoints(this: AgentRuntimeInternal): Promise<SandoRewindPoint[]> {
  return buildRewindPoints(await readActiveMessages(this), await workspaceCheckpoints(this));
}

// ------------------------------------------------------------
// Wording
// ------------------------------------------------------------

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export const SHELL_SIDE_EFFECTS_NOTE =
  "Shell commands are not undone: files they wrote or deleted, packages they installed, git operations and network calls stay as they are.";

function shellWarning(count: number): string | undefined {
  if (count === 0) return undefined;
  return `${plural(count, "shell command")} ran in the rewound turns. ${SHELL_SIDE_EFFECTS_NOTE}`;
}

const IGNORED_REASON_TEXT: Record<WorkspaceFileRewindIgnoredFile["reason"], string> = {
  bash_ignored: "changed by a shell command",
  too_large: "too large to checkpoint (SANDO_CHECKPOINT_MAX_FILE_BYTES)",
  binary: "binary, not checkpointed",
  outside_workspace: "outside the workspace (--confine-to-cwd)",
  checkpoint_pruned: "checkpoint pruned (session checkpoint budget)",
  forced_skip: "skipped by force",
};

function relativeDisplay(runtime: AgentRuntimeInternal, path: string): string {
  const root = runtime.workspaceRoot.endsWith("/") ? runtime.workspaceRoot : `${runtime.workspaceRoot}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

function describeSkipped(runtime: AgentRuntimeInternal, files: WorkspaceFileRewindIgnoredFile[]): string[] {
  return files.map(
    (file) =>
      `  - ${relativeDisplay(runtime, file.path)}: ${IGNORED_REASON_TEXT[file.reason] ?? file.reason}${file.message && file.reason === "forced_skip" ? ` (${file.message})` : ""}`,
  );
}

function describeBlocked(runtime: AgentRuntimeInternal, files: WorkspaceFileRewindUnsafeFile[]): string[] {
  const text: Record<WorkspaceFileRewindUnsafeFile["reason"], string> = {
    checkpoint_missing: "checkpoint missing",
    checkpoint_unreadable: "checkpoint unreadable",
    external_modified: "changed outside the agent since its last edit",
    file_read_failed: "could not be read",
    unsupported_checkpoint: "checkpoint cannot be replayed",
  };
  return files.map(
    (file) =>
      `  - ${relativeDisplay(runtime, file.path)}: ${text[file.reason] ?? file.reason}${file.message ? ` (${file.message})` : ""}`,
  );
}

export function formatRewindPointList(points: readonly SandoRewindPoint[]): string {
  if (points.length === 0) {
    return "Nothing to rewind to yet: this conversation has no user turns.";
  }
  const lines = [
    "Rewind points, newest first. `/rewind to <turn>` restores files and conversation to just before that turn;",
    "add `files` or `conversation` for one of them, `force` to overwrite files changed outside the agent. `/rewind undo` reverses a rewind.",
    "",
  ];
  for (const point of [...points].reverse()) {
    const parts = [
      point.editCount > 0
        ? `${plural(point.editCount, "edit")}${point.editedFiles.length > 0 ? ` (${point.editedFiles.slice(0, 4).join(", ")}${point.editedFiles.length > 4 ? ", …" : ""})` : ""}`
        : "no edits",
    ];
    if (point.shellCommandCount > 0) parts.push(plural(point.shellCommandCount, "shell command"));
    lines.push(`  #${point.turn}  "${point.preview}" · ${parts.join(" · ")}`);
  }
  if (points.some((point) => point.shellCommandCount > 0)) {
    lines.push("", SHELL_SIDE_EFFECTS_NOTE);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------
// Undo records
// ------------------------------------------------------------

function hashOf(content: string | null): string | null {
  if (content === null) return null;
  return createHash("sha256").update(content).digest("hex");
}

async function readFileState(
  runtime: AgentRuntimeInternal,
  path: string,
  traceContext: TraceContext,
): Promise<{ exists: boolean; content: string | null }> {
  try {
    const read = await runtime.fileSystemPort!.readTextFile({ path, trace: traceContext });
    return { exists: true, content: read.content };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return { exists: false, content: null };
    }
    throw error;
  }
}

/** Keep the first state per path: the journal records a path again for each later operation on it. */
function firstStatePerPath(states: readonly WorkspaceFileRewindPriorState[]): WorkspaceFileRewindPriorState[] {
  const seen = new Map<string, WorkspaceFileRewindPriorState>();
  for (const state of states) if (!seen.has(state.path)) seen.set(state.path, state);
  return [...seen.values()];
}

async function saveUndoRecord(
  runtime: AgentRuntimeInternal,
  record: Omit<RewindUndoRecord, "version" | "undoId" | "createdAt" | "leftHashes">,
  traceContext: TraceContext,
): Promise<boolean> {
  if (!runtime.artifactStore || !runtime.sessionStore?.saveSessionEntry) return false;
  if (record.files.length === 0 && !record.conversation) return false;

  const leftHashes: Record<string, string | null> = {};
  for (const file of record.files) {
    if (!runtime.fileSystemPort) break;
    const now = await readFileState(runtime, file.path, traceContext).catch(() => null);
    leftHashes[file.path] = now ? hashOf(now.content) : null;
  }
  const undoId = `undo_${crypto.randomUUID()}`;
  const createdAt = Date.now();
  const full: RewindUndoRecord = { version: 1, undoId, createdAt, leftHashes, ...record };
  try {
    const artifact = await runtime.artifactStore.writeToolResultArtifact({
      sessionId: runtime.sessionId,
      turnId: traceContext.turnId,
      toolCallId: undoId,
      toolName: "sando_rewind_undo",
      content: JSON.stringify(full),
      contentType: UNDO_ARTIFACT_CONTENT_TYPE,
      retention: "session",
      trace: traceContext,
    });
    await runtime.sessionStore.saveSessionEntry({
      id: `sando-rewind-undo:${undoId}`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_SANDO_REWIND_UNDO,
      time: { created: createdAt, updated: createdAt },
      touchSession: false,
      data: {
        undoId,
        artifactUri: artifact.uri,
        createdAt,
        kind: record.kind,
        label: record.label,
        consumed: false,
      } satisfies RewindUndoEntryData,
    });
    return true;
  } catch (error) {
    runtime.logger?.warn("Saving the rewind undo record failed", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "rewind.undo_record.failed",
      module: "core.runtime",
      status: "failed",
    });
    return false;
  }
}

function readUndoEntryData(entry: SessionEntryInfo): RewindUndoEntryData | null {
  const data = entry.data as Partial<RewindUndoEntryData> | undefined;
  if (
    !data ||
    typeof data.undoId !== "string" ||
    typeof data.artifactUri !== "string" ||
    typeof data.createdAt !== "number" ||
    typeof data.label !== "string"
  ) {
    return null;
  }
  return {
    undoId: data.undoId,
    artifactUri: data.artifactUri,
    createdAt: data.createdAt,
    kind: data.kind === "undo" ? "undo" : "rewind",
    label: data.label,
    consumed: data.consumed === true,
  };
}

async function latestUndoEntry(
  runtime: AgentRuntimeInternal,
): Promise<{ entry: SessionEntryInfo; data: RewindUndoEntryData } | null> {
  const entries =
    (await runtime.sessionStore?.sessionEntries?.({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_SANDO_REWIND_UNDO,
    })) ?? [];
  let latest: { entry: SessionEntryInfo; data: RewindUndoEntryData } | null = null;
  for (const entry of entries) {
    const data = readUndoEntryData(entry);
    if (!data || data.consumed) continue;
    if (!latest || data.createdAt >= latest.data.createdAt) latest = { entry, data };
  }
  return latest;
}

export async function getRewindUndoInfo(
  this: AgentRuntimeInternal,
): Promise<SandoRewindUndoInfo | null> {
  const latest = await latestUndoEntry(this);
  if (!latest) return null;
  const { undoId, label, createdAt, kind } = latest.data;
  return { undoId, label, createdAt, kind };
}

// ------------------------------------------------------------
// /rewind to
// ------------------------------------------------------------

function emptyResult(response: string, extra: Partial<SandoRewindResult> = {}): SandoRewindResult {
  return {
    applied: false,
    response,
    restoredFiles: [],
    skippedFiles: [],
    blockedFiles: [],
    conversationRewound: false,
    shellCommandCount: 0,
    undoAvailable: false,
    ...extra,
  };
}

export function resolveRewindPoint(
  points: readonly SandoRewindPoint[],
  target: string,
): SandoRewindPoint | undefined {
  const trimmed = target.trim().replace(/^#/, "");
  if (/^\d+$/.test(trimmed)) {
    const turn = Number.parseInt(trimmed, 10);
    return points.find((point) => point.turn === turn);
  }
  return points.find((point) => point.messageId === trimmed);
}

export async function rewindToTurn(
  this: AgentRuntimeInternal,
  options: {
    target: string;
    scope: RewindScope;
    force?: boolean;
    events: SessionEvent[];
    traceContext: TraceContext;
    abortSignal?: AbortSignal;
  },
): Promise<SandoRewindResult> {
  const scope = options.scope;
  const wantFiles = scope !== RewindScope.Conversation;
  const wantConversation = scope !== RewindScope.Workspace;
  const active = await readActiveMessages(this);
  const points = buildRewindPoints(active, await workspaceCheckpoints(this));
  const point = resolveRewindPoint(points, options.target);
  if (!point) {
    return emptyResult(
      points.length === 0
        ? "Nothing to rewind to yet: this conversation has no user turns."
        : `There is no turn ${options.target} in this conversation (turns 1–${points.length}). Run /rewind list.`,
      { scope },
    );
  }
  if (wantFiles && (!this.artifactStore || !this.fileSystemPort)) {
    return emptyResult("File rewind is unavailable: artifact storage or file access is not configured.", {
      scope,
      turn: point.turn,
    });
  }

  const targetIndex = active.findIndex((message) => message.info.id === point.messageId);
  const suffixIds = active.slice(targetIndex).map((message) => message.info.id as MessageId);
  const priorActiveIds = active.map((message) => message.info.id as MessageId);
  const shellCount = point.shellCommandCountFromHere;
  const base = { scope, turn: point.turn, targetMessageId: point.messageId, shellCommandCount: shellCount };
  const label = `rewind to before turn ${point.turn} ("${point.preview.slice(0, 60)}"), ${scope === RewindScope.Both ? "files + conversation" : scope === RewindScope.Workspace ? "files only" : "conversation only"}`;

  let conversationRewound = false;
  let conversationFailure: string | undefined;
  const runConversation = async () => {
    const before = options.events.length;
    const result = await this.rewindConversationToMessage({
      abortSignal: options.abortSignal,
      events: options.events,
      targetMessageId: point.messageId,
      traceContext: options.traceContext,
    });
    conversationRewound = options.events
      .slice(before)
      .some((event) => event.type === SessionEventType.RewindTriggered);
    if (!conversationRewound) {
      conversationFailure = result.response;
      throw new Error(result.response);
    }
  };

  let restoredFiles: SandoRewindResult["restoredFiles"] = [];
  let skippedFiles: WorkspaceFileRewindIgnoredFile[] = [];
  let priorStates: WorkspaceFileRewindPriorState[] = [];

  if (wantFiles) {
    const preview = await this.previewWorkspaceFileRewind({
      abortSignal: options.abortSignal,
      force: options.force,
      targetMessageIds: suffixIds,
      traceContext: options.traceContext,
    });
    skippedFiles = preview.ignoredFiles;
    const nothingToRestore = preview.safeFiles.length === 0 && preview.unsafeFiles.length === 0;
    if (!nothingToRestore && !preview.canApply) {
      return emptyResult(
        [
          `Rewind to before turn ${point.turn} was not applied; nothing was changed. These files cannot be restored safely:`,
          ...describeBlocked(this, preview.unsafeFiles),
          "Run `/rewind to " +
            point.turn +
            " " +
            (scope === RewindScope.Both ? "both " : "files ") +
            "force` to overwrite or skip them (the rewind stays undoable), or `/rewind to " +
            point.turn +
            " conversation` to leave files alone.",
          shellWarning(shellCount),
        ]
          .filter(Boolean)
          .join("\n"),
        { ...base, blockedFiles: preview.unsafeFiles, skippedFiles },
      );
    }
    if (!nothingToRestore) {
      const applied = await this.applyWorkspaceFileRewind({
        abortSignal: options.abortSignal,
        commitAfterApply: wantConversation ? runConversation : undefined,
        force: options.force,
        targetMessageId: point.messageId,
        targetMessageIds: suffixIds,
        traceContext: options.traceContext,
      });
      if (!applied.applied) {
        return emptyResult(
          [
            `Rewind to before turn ${point.turn} was not applied; files were put back as they were.`,
            conversationFailure ?? applied.response,
            ...describeBlocked(this, applied.preview.unsafeFiles),
          ]
            .filter(Boolean)
            .join("\n"),
          { ...base, blockedFiles: applied.preview.unsafeFiles, skippedFiles },
        );
      }
      priorStates = firstStatePerPath(applied.priorStates ?? []);
      restoredFiles = applied.preview.safeFiles.map((file) => ({ action: file.action, path: file.path }));
      skippedFiles = applied.preview.ignoredFiles;
    } else if (wantConversation) {
      try {
        await runConversation();
      } catch {
        return emptyResult(`Conversation rewind failed: ${conversationFailure ?? "unknown error"}`, base);
      }
    }
  } else {
    try {
      await runConversation();
    } catch {
      return emptyResult(`Conversation rewind failed: ${conversationFailure ?? "unknown error"}`, base);
    }
  }

  if (restoredFiles.length === 0 && !conversationRewound) {
    return emptyResult(
      [
        `Nothing to rewind: no checkpointed file edits from turn ${point.turn} on.`,
        ...(skippedFiles.length > 0 ? ["Not restorable:", ...describeSkipped(this, skippedFiles)] : []),
        shellWarning(shellCount),
      ]
        .filter(Boolean)
        .join("\n"),
      { ...base, skippedFiles },
    );
  }

  const undoAvailable = await saveUndoRecord(
    this,
    {
      kind: "rewind",
      label,
      files: priorStates,
      ...(conversationRewound ? { conversation: { activeMessageIds: priorActiveIds } } : {}),
    },
    options.traceContext,
  );

  if (restoredFiles.length > 0 && !conversationRewound) {
    // The model keeps its history but the files under it changed: tell it, so it re-reads before editing.
    await noticeToModel(
      this,
      [
        `Workspace files were restored to their state before turn ${point.turn} (user rewind). The conversation was not changed.`,
        ...restoredFiles.map((file) => `${file.action} ${relativeDisplay(this, file.path)}`),
        "Re-read these files before editing them; earlier tool results about them are out of date.",
      ],
      options.traceContext,
    );
  }

  const lines = [
    `Rewound to before turn ${point.turn} ("${point.preview}").`,
    wantFiles
      ? restoredFiles.length > 0
        ? `Files: restored ${plural(restoredFiles.length, "file")} — ${restoredFiles.map((file) => `${relativeDisplay(this, file.path)}${file.action === "delete" ? " (deleted, it did not exist then)" : ""}`).join(", ")}.`
        : "Files: no checkpointed edits to restore."
      : "Files: left as they are (conversation only).",
    wantConversation
      ? `Conversation: now ends after turn ${point.turn - 1}${point.turn === 1 ? " (empty)" : ""}; later turns are kept in the session store and come back with /rewind undo.`
      : "Conversation: unchanged (files only).",
    ...(skippedFiles.length > 0 ? ["Not restored:", ...describeSkipped(this, skippedFiles)] : []),
    shellWarning(shellCount),
    undoAvailable ? "Undo with /rewind undo." : "No undo record could be saved for this rewind.",
  ];
  return {
    ...base,
    applied: true,
    response: lines.filter(Boolean).join("\n"),
    restoredFiles,
    skippedFiles,
    blockedFiles: [],
    conversationRewound,
    undoAvailable,
  };
}

async function noticeToModel(
  runtime: AgentRuntimeInternal,
  lines: string[],
  traceContext: TraceContext,
): Promise<void> {
  const body = sanitizeSystemReminderBody(lines);
  await runtime.persistSyntheticUserNotice(createMessageId(), body, traceContext);
  runtime.messageHistory.addAttachment("rewind_notice", body);
}

// ------------------------------------------------------------
// /rewind undo
// ------------------------------------------------------------

export async function undoLastRewind(
  this: AgentRuntimeInternal,
  options: {
    force?: boolean;
    events: SessionEvent[];
    traceContext: TraceContext;
    abortSignal?: AbortSignal;
  },
): Promise<SandoRewindResult> {
  const latest = await latestUndoEntry(this);
  if (!latest || !this.artifactStore) {
    return emptyResult("Nothing to undo: no rewind has been made in this session (or it was already undone).");
  }
  let record: RewindUndoRecord;
  try {
    const read = await this.artifactStore.readToolResultArtifact({
      uri: latest.data.artifactUri,
      trace: options.traceContext,
    });
    record = JSON.parse(read.content) as RewindUndoRecord;
  } catch (error) {
    return emptyResult(
      `The undo record for "${latest.data.label}" cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Files: refuse when a file changed since the rewind left it (unless force); never write outside confinement.
  const files = record.files.filter((file) => isPathAllowedByConfinement(file.path, this.workspaceRoot));
  const outside = record.files.filter((file) => !files.includes(file));
  if (files.length > 0 && !this.fileSystemPort) {
    return emptyResult("Undo is unavailable: file access is not configured.");
  }
  const current: WorkspaceFileRewindPriorState[] = [];
  const changed: string[] = [];
  for (const file of files) {
    const now = await readFileState(this, file.path, options.traceContext);
    current.push({ path: file.path, ...now });
    const expected = record.leftHashes?.[file.path];
    if (expected !== undefined && hashOf(now.content) !== expected) changed.push(file.path);
  }
  if (changed.length > 0 && !options.force) {
    return emptyResult(
      [
        `Undo of "${latest.data.label}" was not applied; nothing was changed. These files changed after the rewind:`,
        ...changed.map((path) => `  - ${relativeDisplay(this, path)}`),
        "Run `/rewind undo force` to put the pre-rewind content back anyway (this undo is itself undoable).",
      ].join("\n"),
    );
  }

  const written: WorkspaceFileRewindPriorState[] = [];
  try {
    for (const file of files) {
      if (file.exists && file.content !== null) {
        await this.fileSystemPort!.writeTextFile({
          path: file.path,
          content: file.content,
          createParents: true,
          atomic: true,
          trace: options.traceContext,
        });
      } else {
        await this.fileSystemPort!.removeFile({ path: file.path, missingOk: true, trace: options.traceContext });
      }
      written.push(current.find((state) => state.path === file.path)!);
    }
  } catch (error) {
    // Same contract as the rewind itself: a failed write puts back what was already written.
    for (const state of [...written].reverse()) {
      if (state.exists && state.content !== null) {
        await this.fileSystemPort!.writeTextFile({
          path: state.path,
          content: state.content,
          createParents: true,
          atomic: true,
          trace: options.traceContext,
        });
      } else {
        await this.fileSystemPort!.removeFile({ path: state.path, missingOk: true, trace: options.traceContext });
      }
    }
    return emptyResult(
      `Undo failed while writing files and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Conversation: make the saved message list the active branch again; anything persisted since is cut off
  // (kept in the store, and the redo record brings it back).
  let conversationRewound = false;
  let currentActiveIds: MessageId[] | undefined;
  if (record.conversation && this.sessionStore) {
    const session = await this.sessionStore.getSession(this.sessionId);
    const persisted = await this.sessionStore.messages({ sessionID: this.sessionId });
    const active = await readActiveMessages(this);
    currentActiveIds = active.map((message) => message.info.id as MessageId);
    const persistedIds = new Set(persisted.map((message) => String(message.info.id)));
    const keptMessageIds = record.conversation.activeMessageIds.filter((id) => persistedIds.has(String(id)));
    const restoredSet = new Set(keptMessageIds.map(String));
    const firstHidden = active.find((message) => !restoredSet.has(String(message.info.id)));
    const cutAfter = persisted.at(-1)?.info.id as MessageId | undefined;
    if (cutAfter) {
      const branchGeneration = (session?.revert?.branchGeneration ?? 0) + 1;
      const targetMessageId = (firstHidden?.info.id ?? cutAfter) as MessageId;
      await this.sessionStore.setRevert({
        sessionID: this.sessionId,
        revert: {
          keptMessageIDs: keptMessageIds,
          branchCutAfterMessageID: cutAfter,
          branchGeneration,
          messageID: keptMessageIds.at(-1) ?? cutAfter,
          kind: "conversation_rewind",
          scope: RewindScope.Conversation,
          targetMessageID: targetMessageId,
        },
      });
      this.branchGeneration = branchGeneration;
      this.runtimeTaskRegistry.setActiveBranchGeneration?.(branchGeneration);
      await rebuildConversationDerivedState.call(this, {
        branchCutAfterMessageId: cutAfter,
        keptMessageIds,
        persistedMessages: persisted,
        targetMessageId,
        traceContext: options.traceContext,
      });
      const event = this.createEvent(
        SessionEventType.RewindTriggered,
        {
          rewindId: `rewind_${crypto.randomUUID()}`,
          scope: RewindScope.Conversation,
          strategy: RewindStrategy.ActiveChain,
          // Only a hidden row can be removed live; restored rows appear when the transcript is re-read.
          ...(firstHidden ? { targetMessageId } : {}),
          branchCutAfterMessageId: cutAfter,
          branchGeneration,
          reason: "sando_rewind_undo",
        },
        options.traceContext,
      );
      await this.appendEvent(event, options.traceContext);
      options.events.push(event);
      conversationRewound = true;
    }
  }

  await this.sessionStore?.saveSessionEntry?.({
    ...latest.entry,
    time: { created: latest.entry.time.created, updated: Date.now() },
    touchSession: false,
    data: { ...latest.data, consumed: true } satisfies RewindUndoEntryData,
  });
  const redoAvailable = await saveUndoRecord(
    this,
    {
      kind: "undo",
      label: `undo of ${latest.data.label}`,
      files: current.filter((state) => written.some((file) => file.path === state.path)),
      ...(conversationRewound && currentActiveIds
        ? { conversation: { activeMessageIds: currentActiveIds } }
        : {}),
    },
    options.traceContext,
  );

  if (written.length > 0 && !conversationRewound) {
    await noticeToModel(
      this,
      [
        "Workspace files were put back to how they were before the last rewind (user undo). The conversation was not changed.",
        ...written.map((state) => relativeDisplay(this, state.path)),
        "Re-read these files before editing them.",
      ],
      options.traceContext,
    );
  }

  const restoredFiles = files.map((file) => ({
    action: (file.exists ? "restore" : "delete") as "restore" | "delete",
    path: file.path,
  }));
  const lines = [
    `Undid ${latest.data.label}.`,
    restoredFiles.length > 0
      ? `Files: put back ${plural(restoredFiles.length, "file")} — ${restoredFiles.map((file) => relativeDisplay(this, file.path)).join(", ")}.`
      : undefined,
    conversationRewound ? "Conversation: restored to what it was before the rewind." : undefined,
    outside.length > 0
      ? `Not touched (outside the workspace, --confine-to-cwd): ${outside.map((file) => file.path).join(", ")}.`
      : undefined,
    redoAvailable ? "Run /rewind undo again to redo." : undefined,
  ];
  return {
    applied: true,
    response: lines.filter(Boolean).join("\n"),
    restoredFiles,
    skippedFiles: [],
    blockedFiles: [],
    conversationRewound,
    shellCommandCount: 0,
    undoAvailable: redoAvailable,
  };
}
