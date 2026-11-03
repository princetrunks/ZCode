// Sando board: resolve the Planner chat for (workspace, session) once, then poll its status while the pane is visible.
import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "@/logger.js";
import {
  ensureSandoBoard,
  fetchSandoBoardStatus,
  pickSandoBoard,
  SANDO_BOARD_POLL_MS,
  type SandoBoardView,
} from "@/lib/sandoBoard.js";

export type SandoBoardState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: SandoBoardView; refreshing: boolean; pollError: string | null };

export function useSandoBoard({
  workspacePath,
  sessionId,
  active,
}: {
  workspacePath: string;
  sessionId: string | null;
  active: boolean;
}) {
  const [state, setState] = useState<SandoBoardState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const viewRef = useRef<SandoBoardView | null>(null);
  viewRef.current = state.kind === "ready" ? state.view : null;

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    ensureSandoBoard(workspacePath, sessionId)
      .then((view) => {
        if (cancelled) return;
        logger.info(`[SandoBoard] chat=${view.binding.chatId} source=${view.source}`);
        setState({ kind: "ready", view, refreshing: false, pollError: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[SandoBoard] ensure failed: ${message}`);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, sessionId, attempt]);

  const refresh = useCallback(async () => {
    const view = viewRef.current;
    if (!view) {
      setAttempt((n) => n + 1);
      return;
    }
    setState((s) => (s.kind === "ready" ? { ...s, refreshing: true } : s));
    try {
      const status = await fetchSandoBoardStatus(view.binding.chatId);
      setState((s) =>
        s.kind === "ready" && s.view.binding.chatId === status.chat_id
          ? {
              kind: "ready",
              // Same board, same text: keep the object so the markdown subtree does not re-render.
              view:
                s.view.status.updated_at === status.updated_at &&
                s.view.status.markdown === status.markdown
                  ? s.view
                  : { ...s.view, status },
              refreshing: false,
              pollError: null,
            }
          : s,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((s) => (s.kind === "ready" ? { ...s, refreshing: false, pollError: message } : s));
    }
  }, []);

  useEffect(() => {
    if (!active || state.kind !== "ready") return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, SANDO_BOARD_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, state.kind, refresh]);

  const pick = useCallback(
    async (chatId: number, scope: "session" | "workspace") => {
      setState((s) => (s.kind === "ready" ? { ...s, refreshing: true } : s));
      try {
        const view = await pickSandoBoard({
          workspace: workspacePath,
          session: sessionId,
          chatId,
          scope,
        });
        logger.info(`[SandoBoard] picked chat=${chatId} scope=${view.source}`);
        setState({ kind: "ready", view, refreshing: false, pollError: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState((s) => (s.kind === "ready" ? { ...s, refreshing: false, pollError: message } : s));
      }
    },
    [workspacePath, sessionId],
  );

  return { state, refresh, pick, retry: () => setAttempt((n) => n + 1) };
}
