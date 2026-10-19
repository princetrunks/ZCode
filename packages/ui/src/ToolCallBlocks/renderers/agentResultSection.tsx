import { PanelRightOpenIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useMemo } from "react";
import {
  formatAgentDuration,
  parseAgentResultSummary,
  type AgentResultSummary,
} from "@/lib/agentResultSummary.js";
import type { ToolSummaryAction } from "../ToolSummaryRow.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { formatAgentMessage } from "./agentHelpers.js";

/**
 * Sando (SANDO-SUBAGENTS.md): the result panel of the collapsible Agent card: status, model, cap,
 * tool uses, duration, files touched and the child's returned message (never its transcript).
 */
export function AgentResultSection({
  summary,
  status,
  context,
}: {
  summary: AgentResultSummary;
  status: string | undefined;
  context: Pick<
    ToolCallBlockRenderContext,
    | "workspacePath"
    | "theme"
    | "codePreviewSettings"
    | "onOpenCodeViewer"
    | "onOpenFileLink"
    | "onOpenBrowserUrl"
  >;
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string, fallback: string) => formatAgentMessage(intl, id, fallback);
  const statusText =
    status === "failed"
      ? msg("chat.toolCall.agent.result.failed", "Failed")
      : msg("chat.toolCall.agent.result.completed", "Completed");
  const facts: Array<{ key: string; label: string; value: string }> = [
    ...(summary.model
      ? [
          {
            key: "model",
            label: msg("chat.toolCall.agent.result.model", "Model"),
            value: summary.model,
          },
        ]
      : []),
    ...(summary.turnCap !== undefined
      ? [
          {
            key: "cap",
            label: msg("chat.toolCall.agent.result.turnCap", "Step cap"),
            value: String(summary.turnCap),
          },
        ]
      : []),
    ...(summary.toolUses !== undefined
      ? [
          {
            key: "tools",
            label: msg("chat.toolCall.agent.result.toolUses", "Tool uses"),
            value: String(summary.toolUses),
          },
        ]
      : []),
    ...(summary.durationMs !== undefined
      ? [
          {
            key: "time",
            label: msg("chat.toolCall.agent.result.duration", "Time"),
            value: formatAgentDuration(summary.durationMs),
          },
        ]
      : []),
  ];
  const files = summary.filesTouched;
  return (
    <section
      data-testid="sando-agent-result"
      data-agent-result-status={status === "failed" ? "failed" : "completed"}
      className="rounded-lg border border-border bg-background-alt/40 text-ui-base"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
        <span
          className={cn(
            "font-medium",
            status === "failed" ? "text-destructive" : "text-foreground-subtle",
          )}
        >
          {statusText}
        </span>
        {facts.map((fact) => (
          <span key={fact.key} className="min-w-0 text-foreground-subtlest">
            {fact.label}{" "}
            <span className="break-all font-mono text-foreground-subtle">{fact.value}</span>
          </span>
        ))}
      </div>
      {files !== undefined ? (
        <div className="border-border border-t px-3 py-2">
          <div className="text-foreground-subtlest">
            {msg("chat.toolCall.agent.result.filesTouched", "Files changed")}
          </div>
          {files.length === 0 ? (
            <div className="text-foreground-subtle">
              {msg("chat.toolCall.agent.result.noFiles", "None")}
            </div>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {files.map((file) => (
                <li key={file} className="break-all font-mono text-foreground-subtle">
                  {file}
                </li>
              ))}
              {summary.moreFiles ? (
                <li className="text-foreground-subtlest">+{summary.moreFiles}</li>
              ) : null}
            </ul>
          )}
        </div>
      ) : null}
      {summary.body ? (
        <div
          className="max-h-64 overflow-auto border-border border-t"
          data-markdown-table-sticky-scrollbar="disabled"
        >
          <MessageResponse
            className="px-3 py-2 min-w-0 break-words text-ui-base [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenExternalUrl={context.onOpenBrowserUrl}
          >
            {summary.body}
          </MessageResponse>
        </div>
      ) : null}
      {summary.truncated ? (
        <div className="border-border border-t px-3 py-2 text-foreground-subtlest">
          {msg(
            "chat.toolCall.agent.result.truncated",
            "Shortened to the result budget; the full text is in the agent's result.md.",
          )}
        </div>
      ) : null}
    </section>
  );
}

/** Sando: the full child timeline (side pane / phone drawer), one button inside the expanded card. */
export function AgentOpenSessionButton({
  action,
}: {
  action: Omit<ToolSummaryAction, "ariaLabel">;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Button
      data-testid={action.testId}
      onClick={action.onActivate}
      size="sm"
      type="button"
      variant="outline"
    >
      <PanelRightOpenIcon className="size-4" />
      {formatAgentMessage(intl, "chat.toolCall.agent.openInSidePane", "Open on the right")}
    </Button>
  );
}

/** Sando: the finished Agent call's result (none while it runs, or for a background launch). */
export function useAgentResultSummary(
  running: boolean,
  output: unknown,
  activityContent: string | undefined,
): AgentResultSummary | null {
  return useMemo(
    () =>
      running
        ? null
        : (parseAgentResultSummary(output) ?? parseAgentResultSummary(activityContent)),
    [activityContent, output, running],
  );
}
