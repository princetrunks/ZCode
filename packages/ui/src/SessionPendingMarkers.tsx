// Sando: small per-session pending markers for task rows and the open session's header (2026-10-21).
// Rows: two count chips (queued messages, running sub-agents) next to the title; the running / waiting /
// unread state stays in the row's existing 16 px leading slot. Header: one compact status line.
import { memo } from "react";
import { Bot, ListOrdered, LoaderIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { describeSessionPending, type SessionPendingState } from "@/lib/sessionPendingIndicator.js";

type FormatMessage = (id: string, values?: Record<string, string>) => string;

const CHIP_CLASS =
  "inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full bg-secondary px-1 text-ui-xs font-medium leading-none tabular-nums text-foreground-subtle";

/** Queue / sub-agent count chips; renders nothing when both are zero. */
function SessionPendingCountsImpl({
  state,
  formatMessage,
  className,
}: {
  state: SessionPendingState;
  formatMessage: FormatMessage;
  className?: string;
}) {
  if (state.queued <= 0 && state.agents <= 0) return null;
  const queuedLabel =
    state.queued > 0
      ? formatMessage(
          state.queuePaused
            ? "sandoPending.queuedPaused"
            : state.queued === 1
              ? "sandoPending.queuedOne"
              : "sandoPending.queuedMany",
          { count: String(state.queued) },
        )
      : null;
  const agentsLabel =
    state.agents > 0
      ? formatMessage(state.agents === 1 ? "sandoPending.agentsOne" : "sandoPending.agentsMany", {
          count: String(state.agents),
        })
      : null;
  return (
    <span
      data-session-pending-counts="true"
      className={cn("inline-flex shrink-0 items-center gap-1", className)}
    >
      {queuedLabel ? (
        <span
          data-session-pending-queued={state.queued}
          title={queuedLabel}
          aria-label={queuedLabel}
          role="img"
          className={cn(CHIP_CLASS, state.queuePaused && "text-warning")}
        >
          <ListOrdered aria-hidden="true" className="size-2.5" />
          {state.queued}
        </span>
      ) : null}
      {agentsLabel ? (
        <span
          data-session-pending-agents={state.agents}
          title={agentsLabel}
          aria-label={agentsLabel}
          role="img"
          className={CHIP_CLASS}
        >
          <Bot aria-hidden="true" className="size-2.5" />
          {state.agents}
        </span>
      ) : null}
    </span>
  );
}

export const SessionPendingCounts = memo(SessionPendingCountsImpl);

/** The dot used in a row's leading slot for "waiting on you" (amber). */
export function SessionWaitingDot() {
  return (
    <span
      data-waiting-indicator="true"
      className="h-1.5 w-1.5 rounded-full bg-warning ring-2 ring-warning/25"
    />
  );
}

/**
 * Open session's header: "Working… · 2 queued messages · 1 sub-agent running" (or "Waiting for …").
 * Below 768 px only the icon + counts show, the full sentence stays in the tooltip / screen-reader label.
 */
function SessionPendingHeaderStatusImpl({
  state,
  formatMessage,
}: {
  state: SessionPendingState;
  formatMessage: FormatMessage;
}) {
  const parts = describeSessionPending(state, formatMessage, { includeUnread: false });
  if (parts.length === 0) return null;
  const label = parts.join(" · ");
  return (
    <span
      data-session-pending-header="true"
      data-waiting={state.waiting ?? undefined}
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
      className={cn(
        // Phones show only icon + chips: never shrink (a squeezed pill pushed its chip over the ⋯ button
        // at 390 px); the truncating title gives way instead. From 768 px the sentence may truncate.
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-ui-sm font-normal md:min-w-0 md:shrink",
        state.waiting ? "bg-warning/12 text-warning" : "bg-secondary text-foreground-subtle",
      )}
    >
      {state.waiting ? (
        <SessionWaitingDot />
      ) : state.running ? (
        <LoaderIcon aria-hidden="true" className="size-3 shrink-0 animate-spin" />
      ) : null}
      <span aria-hidden="true" className="hidden min-w-0 truncate md:inline">
        {label}
      </span>
      <SessionPendingCounts state={state} formatMessage={formatMessage} className="md:hidden" />
    </span>
  );
}

export const SessionPendingHeaderStatus = memo(SessionPendingHeaderStatusImpl);
