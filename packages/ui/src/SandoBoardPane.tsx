// Sando board (2026-11-03): a Project Planner chat's status board beside the conversation (web workbench side pane; the
// phone layout shows the same pane in an off-canvas drawer). The session's model keeps the board current through the
// Planner MCP tool update_chat_status; this pane only reads it, polling while visible.
import { useMemo, useState } from "react";
import {
  CheckIcon,
  ExternalLinkIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  RefreshCwIcon,
  Repeat2Icon,
  XIcon,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useSandoBoard } from "@/hooks/useSandoBoard.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  absolutizePlannerLinks,
  listSandoBoardChats,
  orderPickerChats,
  parsePlannerTime,
  type SandoBoardChat,
} from "@/lib/sandoBoard.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";

export interface SandoBoardPaneProps {
  workspacePath: string;
  sessionId: string | null;
  /** Poll only while the pane is on screen. */
  active: boolean;
  onClose?: () => void;
  className?: string;
}

function BoardPicker({
  currentId,
  hasSession,
  onPick,
}: {
  currentId: number;
  hasSession: boolean;
  onPick: (chatId: number, scope: "session" | "workspace") => void;
}) {
  const { intl } = useZCodeIntl();
  const [chats, setChats] = useState<SandoBoardChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionOnly, setSessionOnly] = useState(false);
  const ordered = useMemo(
    () => (chats ? orderPickerChats(chats, currentId) : []),
    [chats, currentId],
  );

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open || chats) return;
        listSandoBoardChats()
          .then(setChats)
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`[SandoBoard] chat list failed: ${message}`);
            setError(message);
          });
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "sandoBoard.change" })}
          title={intl.formatMessage({ id: "sandoBoard.change" })}
          data-sando-board-picker=""
        >
          <Repeat2Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "sandoBoard.pickTitle" })}
        </DropdownMenuLabel>
        {hasSession ? (
          <DropdownMenuCheckboxItem
            checked={sessionOnly}
            onCheckedChange={(v) => setSessionOnly(v === true)}
            onSelect={(e) => e.preventDefault()}
          >
            {intl.formatMessage({ id: "sandoBoard.sessionOnly" })}
          </DropdownMenuCheckboxItem>
        ) : null}
        <DropdownMenuSeparator />
        <div className="max-h-80 overflow-y-auto">
          {error ? (
            <div className="px-2 py-1.5 text-ui-sm text-destructive">{error}</div>
          ) : !chats ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-ui-sm text-foreground-subtle">
              <Spinner className="size-3" />
              {intl.formatMessage({ id: "sandoBoard.loading" })}
            </div>
          ) : (
            ordered.map((c) => (
              <DropdownMenuItem
                key={c.id}
                onSelect={() => onPick(c.id, sessionOnly && hasSession ? "session" : "workspace")}
              >
                {c.id === currentId ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <span className="size-3.5" />
                )}
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                  {c.hasBoard ? "▦ " : ""}#{c.id}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SandoBoardPane({
  workspacePath,
  sessionId,
  active,
  onClose,
  className,
}: SandoBoardPaneProps) {
  const { intl } = useZCodeIntl();
  const { state, refresh, pick, retry } = useSandoBoard({ workspacePath, sessionId, active });
  const markdown = state.kind === "ready" ? state.view.status.markdown : "";
  const rendered = useMemo(() => absolutizePlannerLinks(markdown), [markdown]);

  const sourceLabel =
    state.kind === "ready"
      ? intl.formatMessage({ id: `sandoBoard.source.${state.view.source}` })
      : "";
  const updatedAt = state.kind === "ready" ? parsePlannerTime(state.view.status.updated_at) : null;

  return (
    <div
      data-sando-board-pane=""
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <LayoutDashboardIcon className="size-3.5 shrink-0 text-foreground-subtle" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-base font-medium text-foreground">
            {state.kind === "ready"
              ? state.view.binding.title || `#${state.view.binding.chatId}`
              : intl.formatMessage({ id: "sandoBoard.title" })}
          </div>
          {state.kind === "ready" ? (
            <div className="truncate text-ui-xs text-foreground-subtlest" data-sando-board-meta="">
              #{state.view.binding.chatId} · {sourceLabel}
              {updatedAt
                ? ` · ${intl.formatMessage(
                    { id: "sandoBoard.updated" },
                    {
                      when: formatTaskRelativeTime(updatedAt, intl),
                      who: state.view.status.updated_by ?? "?",
                    },
                  )}`
                : ""}
            </div>
          ) : null}
        </div>
        {state.kind === "ready" ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "sandoBoard.refresh" })}
              title={intl.formatMessage({ id: "sandoBoard.refresh" })}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon className={cn(state.refreshing && "animate-spin")} />
            </Button>
            <BoardPicker
              currentId={state.view.binding.chatId}
              hasSession={Boolean(sessionId)}
              onPick={(chatId, scope) => void pick(chatId, scope)}
            />
            {state.view.status.url && state.view.status.url !== state.view.link ? (
              <Button variant="ghost" size="icon-sm" asChild>
                <a
                  href={state.view.status.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={intl.formatMessage({ id: "sandoBoard.fullReport" })}
                  title={intl.formatMessage({ id: "sandoBoard.fullReport" })}
                >
                  <FileTextIcon />
                </a>
              </Button>
            ) : null}
            <Button variant="ghost" size="icon-sm" asChild>
              <a
                href={state.view.link}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={intl.formatMessage({ id: "sandoBoard.openInPlanner" })}
                title={intl.formatMessage({ id: "sandoBoard.openInPlanner" })}
              >
                <ExternalLinkIcon />
              </a>
            </Button>
          </>
        ) : null}
        {onClose ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "sandoBoard.close" })}
            onClick={onClose}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      {state.kind === "ready" && state.pollError ? (
        <div className="shrink-0 border-b border-border px-3 py-1 text-ui-xs text-destructive">
          {state.pollError}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {state.kind === "loading" ? (
          <div className="flex h-full items-center justify-center gap-2 text-ui-sm text-foreground-subtle">
            <Spinner className="size-4" />
            {intl.formatMessage({ id: "sandoBoard.loading" })}
          </div>
        ) : state.kind === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="text-ui-base text-foreground">
              {intl.formatMessage({ id: "sandoBoard.unavailable" })}
            </div>
            <div className="text-ui-sm text-foreground-subtle">{state.message}</div>
            <Button variant="outline" onClick={retry}>
              {intl.formatMessage({ id: "sandoBoard.retry" })}
            </Button>
          </div>
        ) : markdown.trim() ? (
          <div className="p-4" data-sando-board-body="">
            <MessageResponse className="min-w-0 break-words">{rendered}</MessageResponse>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "sandoBoard.empty" })}
          </div>
        )}
      </div>
    </div>
  );
}
