// Sando: per-session "pending" facts for the sidebar / header indicator (2026-10-21).
// Pure, cheap derivation from a ConversationSnapshot that the sessions-index projection already holds:
// queued inputs, running sub-agents, and an unanswered ```form at the end of the thread.
// No row text leaves the CLI; only counts and one boolean go into SessionSummary.
import type { ConversationSnapshot } from "./snapshot.js";

export interface SessionPendingFacts {
  /** Inputs waiting in the session queue (not yet promoted into a turn). */
  queuedCount: number;
  /** true when the queue holds items but is paused (stop / manual hold / error). */
  queuePaused: boolean;
  /** Native sub-agents (Agent/Task children) still running, waiting or blocked. */
  runningSubagentCount: number;
  /** The last reply ends the thread with a ```form the user has not answered yet. */
  awaitingForm: boolean;
}

// An opening fence line whose info string is exactly "form" (same rule as the web workbench's isFormLanguage).
const FORM_FENCE_RE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*form[ \t]*$/im;

export function textHasFormBlock(text: string): boolean {
  return FORM_FENCE_RE.test(text);
}

/**
 * Walk back from the newest row: the first userInput means the user already spoke after any form;
 * the first finished assistantText decides. Other rows (tool calls, markers) are skipped.
 */
function deriveAwaitingForm(snapshot: ConversationSnapshot): boolean {
  const phase = snapshot.control.phase;
  if (phase === "running" || phase === "prewarming") return false;
  const rows = snapshot.rows.window;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row) continue;
    if (row.kind === "userInput") return false;
    if (row.kind === "assistantText") {
      if (row.state !== "complete") return false;
      if (row.text.trim().length === 0) continue;
      return textHasFormBlock(row.text);
    }
  }
  return false;
}

export function deriveSessionPendingFacts(snapshot: ConversationSnapshot): SessionPendingFacts {
  const queuedCount = snapshot.queue.items.filter(
    (item) => item.dispatch.state === "queued" || item.dispatch.state === "reserved",
  ).length;
  const runningSubagentCount = snapshot.subagents
    ? snapshot.subagents.running.length
    : snapshot.backgroundWorks.filter((w) => w.kind === "subagent" && w.status === "running")
        .length;
  return {
    queuedCount,
    queuePaused: queuedCount > 0 && !snapshot.queue.autoDrain,
    runningSubagentCount,
    awaitingForm: deriveAwaitingForm(snapshot),
  };
}
