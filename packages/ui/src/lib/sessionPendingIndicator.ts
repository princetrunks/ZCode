// Sando: per-session "pending" indicator (2026-10-21), the same vocabulary as the Planner's Chat / Lily lists:
// a turn is running, n queued messages, n sub-agents running, waiting on you (approval / answer / ```form),
// and an unread reply. Pure: rows and the open session's header both read it from the sessions-index sidecar.
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskListRowActivity } from "@/v4/taskListRowActivity.js";

export type SessionWaitingKind = "permission" | "userInput" | "form";

export interface SessionPendingState {
  running: boolean;
  /** What the session is blocked on from the user, if anything. */
  waiting: SessionWaitingKind | null;
  queued: number;
  queuePaused: boolean;
  agents: number;
  unread: boolean;
}

export const EMPTY_SESSION_PENDING_STATE: SessionPendingState = {
  running: false,
  waiting: null,
  queued: 0,
  queuePaused: false,
  agents: 0,
  unread: false,
};

export function deriveSessionPendingState(
  task: Pick<ZCodeTaskMeta, "pendingInteraction" | "unreadAt">,
  activity: TaskListRowActivity | null,
): SessionPendingState {
  const running = activity?.phase === "running" || activity?.phase === "prewarming";
  const interactions = activity?.pendingInteractions;
  let waiting: SessionWaitingKind | null = null;
  if (task.pendingInteraction) {
    waiting = task.pendingInteraction.kind;
  } else if (interactions && interactions.userInputCount > 0) {
    waiting = "userInput";
  } else if (interactions && interactions.permissionCount > 0) {
    waiting = "permission";
  } else if (activity?.awaitingForm && !running) {
    waiting = "form";
  }
  return {
    running,
    waiting,
    queued: Math.max(0, activity?.queuedCount ?? 0),
    queuePaused: activity?.queuePaused === true,
    agents: Math.max(0, activity?.runningSubagentCount ?? 0),
    unread: typeof task.unreadAt === "number",
  };
}

export function hasSessionPendingCounts(state: SessionPendingState): boolean {
  return state.queued > 0 || state.agents > 0;
}

type FormatMessage = (id: string, values?: Record<string, string>) => string;

/** Message id for "waiting on you" by kind (shared by the tooltip, the header and screen readers). */
export function waitingMessageId(kind: SessionWaitingKind): string {
  return kind === "form"
    ? "sandoPending.waitingForm"
    : kind === "userInput"
      ? "sandoPending.waitingAnswer"
      : "sandoPending.waitingApproval";
}

/**
 * Ordered, human parts: "Working…", "Waiting for your answer", "2 queued", "1 sub-agent running", "New reply".
 * `includeUnread` is false for the open session's header (it is being read).
 */
export function describeSessionPending(
  state: SessionPendingState,
  formatMessage: FormatMessage,
  options: { includeUnread?: boolean } = {},
): string[] {
  const parts: string[] = [];
  if (state.waiting) {
    parts.push(formatMessage(waitingMessageId(state.waiting)));
  } else if (state.running) {
    parts.push(formatMessage("sandoPending.working"));
  }
  if (state.queued > 0) {
    parts.push(
      formatMessage(
        state.queuePaused
          ? "sandoPending.queuedPaused"
          : state.queued === 1
            ? "sandoPending.queuedOne"
            : "sandoPending.queuedMany",
        { count: String(state.queued) },
      ),
    );
  }
  if (state.agents > 0) {
    parts.push(
      formatMessage(state.agents === 1 ? "sandoPending.agentsOne" : "sandoPending.agentsMany", {
        count: String(state.agents),
      }),
    );
  }
  if ((options.includeUnread ?? true) && state.unread) {
    parts.push(formatMessage("sandoPending.unread"));
  }
  return parts;
}
