// Sando: the open session's pending state for its header (2026-10-21).
// Reads the same ref-counted sessions-index store the sidebar already holds (no new connection when the
// sidebar is mounted) and re-renders only when this session's pending facts change.
import { useEffect, useState } from "react";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  deriveSessionPendingState,
  EMPTY_SESSION_PENDING_STATE,
  type SessionPendingState,
} from "@/lib/sessionPendingIndicator.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";

/** SessionSummary → pending state (the open session is being read, so no unread). */
export function sessionPendingStateFromSummary(
  summary: SessionSummary | undefined,
): SessionPendingState {
  if (!summary) return EMPTY_SESSION_PENDING_STATE;
  return deriveSessionPendingState(
    { pendingInteraction: summary.pendingInteraction, unreadAt: undefined },
    {
      phase: summary.phase,
      lastActivityAt: summary.lastActivityAt,
      hasBackgroundWork: summary.hasBackgroundWork,
      ...(summary.pendingInteractionSummary
        ? { pendingInteractions: summary.pendingInteractionSummary }
        : {}),
      ...(summary.queuedCount ? { queuedCount: summary.queuedCount } : {}),
      ...(summary.queuePaused ? { queuePaused: true } : {}),
      ...(summary.runningSubagentCount
        ? { runningSubagentCount: summary.runningSubagentCount }
        : {}),
      ...(summary.awaitingForm ? { awaitingForm: true } : {}),
    },
  );
}

function sameState(a: SessionPendingState, b: SessionPendingState): boolean {
  return (
    a.running === b.running &&
    a.waiting === b.waiting &&
    a.queued === b.queued &&
    a.queuePaused === b.queuePaused &&
    a.agents === b.agents &&
    a.unread === b.unread
  );
}

export function useSessionPendingState(params: {
  sessionId: string | null | undefined;
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  agentService: SessionsIndexAgentService | null | undefined;
}): SessionPendingState {
  const { sessionId, workspacePath, agentService } = params;
  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = params.remoteSessionId || undefined;
  const [state, setState] = useState<SessionPendingState>(EMPTY_SESSION_PENDING_STATE);

  useEffect(() => {
    if (!sessionId || !workspacePath || !agentService) {
      setState(EMPTY_SESSION_PENDING_STATE);
      return;
    }
    const scope: SessionsIndexScope = {
      workspaceKey: workspaceIdentity || workspacePath,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { endpointKey: remoteSessionId } : {}),
    };
    const store = acquireSessionsIndex(scope, agentService);
    const evaluate = () => {
      const summary = store.getSessions().find((item) => item.sessionId === sessionId);
      const next = sessionPendingStateFromSummary(summary);
      setState((prev) => (sameState(prev, next) ? prev : next));
    };
    const unsubscribe = store.subscribe(evaluate);
    evaluate();
    return () => {
      unsubscribe();
      releaseSessionsIndex(scope, store);
    };
  }, [agentService, remoteSessionId, sessionId, workspaceIdentity, workspacePath]);

  return state;
}
