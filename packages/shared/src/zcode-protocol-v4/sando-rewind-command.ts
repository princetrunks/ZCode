// Sando: turn-keyed rewind for the web workbench (same runtime as the CLI's /rewind list | to | undo).
// Three native commands; their ACK carries the result, so the workbench needs no new query route:
//   listRewindPoints  → turns of the active branch with edit / shell counts + the record /rewind undo would apply
//   rewindToTurn      → restore files and/or conversation to just before a turn (undoable)
//   undoRewind        → reverse the last rewind (running it again redoes)
// Shell command side effects are never undone; results carry shellCommandCount so the UI can say so.
import { z } from "zod";
import {
  v4WorkspaceFileRewindIgnoredFileSchema,
  v4WorkspaceFileRewindUnsafeFileSchema,
} from "./transport.js";

export const sandoRewindScopeSchema = z.enum(["both", "files", "conversation"]);
export type SandoRewindScope = z.infer<typeof sandoRewindScopeSchema>;

export const listRewindPointsPayloadSchema = z.object({}).strict();
export const rewindToTurnPayloadSchema = z
  .object({
    /** The user prompt's message id (SandoRewindPoint.messageId); the turn number can shift after a rewind. */
    targetMessageId: z.string().min(1),
    scope: sandoRewindScopeSchema,
    force: z.boolean().optional(),
  })
  .strict();
export const undoRewindPayloadSchema = z.object({ force: z.boolean().optional() }).strict();

export const sandoRewindPointSchema = z
  .object({
    turn: z.number().int().positive(),
    messageId: z.string().min(1),
    preview: z.string(),
    createdAt: z.number(),
    editCount: z.number().int().nonnegative(),
    editedFiles: z.array(z.string()),
    shellCommandCount: z.number().int().nonnegative(),
    editCountFromHere: z.number().int().nonnegative(),
    shellCommandCountFromHere: z.number().int().nonnegative(),
  })
  .strict();
export type SandoRewindPointWire = z.infer<typeof sandoRewindPointSchema>;

export const sandoRewindUndoInfoSchema = z
  .object({
    undoId: z.string().min(1),
    label: z.string(),
    createdAt: z.number(),
    kind: z.enum(["rewind", "undo"]),
  })
  .strict();
export type SandoRewindUndoInfoWire = z.infer<typeof sandoRewindUndoInfoSchema>;

export const listRewindPointsResultSchema = z.object({
  type: z.literal("listRewindPoints"),
  points: z.array(sandoRewindPointSchema),
  undo: sandoRewindUndoInfoSchema.nullable(),
});

export const sandoRewindResultSchema = z.object({
  type: z.enum(["rewindToTurn", "undoRewind"]),
  applied: z.boolean(),
  /** Plain-English summary, the same text the CLI prints. */
  response: z.string(),
  turn: z.number().int().positive().optional(),
  restoredFiles: z.array(z.object({ action: z.enum(["restore", "delete"]), path: z.string() }).strict()),
  skippedFiles: z.array(v4WorkspaceFileRewindIgnoredFileSchema),
  blockedFiles: z.array(v4WorkspaceFileRewindUnsafeFileSchema),
  conversationRewound: z.boolean(),
  shellCommandCount: z.number().int().nonnegative(),
  /** What /rewind undo would apply now (null: nothing to undo). */
  undo: sandoRewindUndoInfoSchema.nullable(),
});
export type SandoRewindCommandResult = z.infer<typeof sandoRewindResultSchema>;
