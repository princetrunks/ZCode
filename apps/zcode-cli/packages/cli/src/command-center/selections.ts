import type { TuiSelection, TuiSelectionItem } from "@zcode/tui";
import type {
  CommandCenterCheckpoint,
  CommandCenterRewindPoint,
  CommandCenterSession,
  CommandCenterTarget,
} from "./types.js";
import { formatTime, shortId, shortText } from "./utils.js";

const COMPOSER_SELECTION_PLACEMENT = "composer";

export function buildSessionSelection(sessions: CommandCenterSession[]): TuiSelection {
  return {
    emptyMessage: "No saved sessions found for this directory.",
    help: "Type to filter, Up/Down choose, Enter resumes, Esc cancels",
    items: sessions.map(sessionToSelectionItem),
    placement: COMPOSER_SELECTION_PLACEMENT,
    prompt: "Choose a session to resume.",
    title: "Resume Session",
  };
}

function sessionToSelectionItem(session: CommandCenterSession): TuiSelectionItem {
  const forkMeta = session.parentId ? `fork of ${shortId(session.parentId)}` : "root";
  return {
    command: `/resume ${session.id}`,
    id: session.id,
    keywords: [session.directory, session.title, session.parentId ?? ""],
    meta: `${formatTime(session.updatedAt)} | ${forkMeta}`,
    primary: session.title || session.id,
    secondary: `${shortId(session.id)} | ${session.directory}`,
  };
}

export function buildCheckpointSelection(
  action: "fork" | "rewind",
  checkpoints: CommandCenterCheckpoint[],
): TuiSelection {
  const verb = action === "fork" ? "fork from" : "rewind to";
  return {
    emptyMessage: "No workspace checkpoints are available yet.",
    help: `Type to filter, Up/Down choose, Enter ${verb}, Esc cancels`,
    items: checkpoints.map((checkpoint) => checkpointToSelectionItem(action, checkpoint)),
    ...(action === "rewind" ? { placement: COMPOSER_SELECTION_PLACEMENT } : {}),
    prompt: `Choose a checkpoint to ${verb}.`,
    title: action === "fork" ? "Fork From Checkpoint" : "Rewind To Checkpoint",
  };
}

function checkpointToSelectionItem(
  action: "fork" | "rewind",
  checkpoint: CommandCenterCheckpoint,
): TuiSelectionItem {
  const fileCount =
    checkpoint.fileCount === undefined
      ? "unknown files"
      : `${checkpoint.fileCount} file${checkpoint.fileCount === 1 ? "" : "s"}`;
  const compact = checkpoint.coveredByCompact
    ? ` | compact ${checkpoint.compactBoundaryId ?? "covered"}`
    : "";
  const preview = checkpoint.preview ?? `message ${shortId(checkpoint.messageId)}`;
  return {
    command: `/${action} ${checkpoint.checkpointId}`,
    id: checkpoint.checkpointId,
    keywords: [
      checkpoint.messageId,
      checkpoint.scope,
      checkpoint.compactBoundaryId ?? "",
      checkpoint.preview ?? "",
    ],
    meta: `${fileCount} | ${formatTime(checkpoint.createdAt)}${compact}`,
    primary: preview,
    secondary: shortId(checkpoint.checkpointId),
  };
}

const SHELL_NOT_UNDONE =
  "Shell commands are not undone: files they wrote, packages they installed, git operations stay.";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Sando: `/rewind` with no arguments — pick the turn to go back to (state just before it). */
export function buildRewindPointSelection(points: CommandCenterRewindPoint[]): TuiSelection {
  return {
    emptyMessage: "Nothing to rewind to yet: this conversation has no user turns.",
    help: "Type to filter, Up/Down choose, Enter picks the turn (then files / conversation / both), Esc cancels",
    items: [...points].reverse().map((point) => ({
      command: `/rewind pick ${point.turn}`,
      id: point.messageId,
      keywords: [point.preview, ...point.editedFiles, String(point.turn)],
      meta: [
        point.editCount > 0 ? plural(point.editCount, "edit") : "no edits",
        point.shellCommandCount > 0 ? plural(point.shellCommandCount, "shell command") : "",
        formatTime(point.createdAt),
      ]
        .filter(Boolean)
        .join(" | "),
      primary: `#${point.turn}  ${point.preview}`,
      secondary: point.editedFiles.length > 0 ? shortText(point.editedFiles.join(", "), 80) : undefined,
    })),
    placement: COMPOSER_SELECTION_PLACEMENT,
    prompt: "Rewind to just before which turn? /rewind undo reverses a rewind.",
    title: "Rewind",
  };
}

/** Sando: second step — what to restore for the chosen turn. */
export function buildRewindScopeSelection(point: CommandCenterRewindPoint): TuiSelection {
  const edits =
    point.editCountFromHere > 0
      ? `undo ${plural(point.editCountFromHere, "file edit")} from turn ${point.turn} on`
      : "no file edits to undo";
  const shell =
    point.shellCommandCountFromHere > 0
      ? ` ${plural(point.shellCommandCountFromHere, "shell command")} ran since. ${SHELL_NOT_UNDONE}`
      : "";
  return {
    emptyMessage: "",
    filterable: false,
    help: "Up/Down choose, Enter rewinds (undoable with /rewind undo), Esc cancels",
    items: [
      {
        command: `/rewind to ${point.turn} both`,
        id: "both",
        meta: edits,
        primary: "Files and conversation",
        secondary: `Files and chat go back to just before turn ${point.turn}`,
      },
      {
        command: `/rewind to ${point.turn} conversation`,
        id: "conversation",
        meta: "files stay as they are",
        primary: "Conversation only",
        secondary: `The chat ends after turn ${point.turn - 1}; your files are untouched`,
      },
      {
        command: `/rewind to ${point.turn} files`,
        id: "files",
        meta: edits,
        primary: "Files only",
        secondary: "The chat keeps every turn; the agent is told the files changed",
      },
    ],
    placement: COMPOSER_SELECTION_PLACEMENT,
    prompt: `Rewind to before #${point.turn} "${shortText(point.preview, 60)}".${shell}`,
    title: "Rewind: what to restore",
  };
}

export function buildTargetReplaceSelection(
  existing: CommandCenterTarget,
  objective: string,
): TuiSelection {
  return {
    emptyMessage: "No goal replacement actions are available.",
    help: "Enter replaces the current goal, Esc cancels",
    items: [
      {
        command: `/goal replace ${objective}`,
        id: "replace-goal",
        keywords: [objective, existing.objective],
        meta: `Current: ${shortText(existing.objective, 80)}`,
        primary: "Replace current goal",
        secondary: shortText(objective, 100),
      },
    ],
    prompt: "Replace the current goal?",
    title: "Replace Goal",
  };
}
