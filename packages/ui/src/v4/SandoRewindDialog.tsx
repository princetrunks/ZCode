// Sando: workbench Rewind dialog — pick a turn, choose files / conversation / both, rewind; undo the last rewind.
// Same runtime as the CLI's `/rewind` (listRewindPoints / rewindToTurn / undoRewind commands). Opened by typing
// `/rewind` in the composer. Shell command side effects are never undone; the dialog says so when they ran.
import { useCallback, useEffect, useMemo, useState } from "react";
import { HistoryIcon, Loader2Icon, TerminalIcon, Undo2Icon } from "lucide-react";
import type {
  CommandAck,
  CommandType,
  SandoRewindCommandResult,
  SandoRewindPointWire,
  SandoRewindScope,
  SandoRewindUndoInfoWire,
} from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  REWIND_IGNORED_REASON_KEYS,
  canForce,
  newestFirst,
  readRewindActionAck,
  readRewindListAck,
  rewindCoverage,
} from "@/lib/sandoRewind.js";
import { cn } from "@/components/lib/utils.js";

export type SandoRewindDispatch = (
  type: Extract<CommandType, "listRewindPoints" | "rewindToTurn" | "undoRewind">,
  payload: Record<string, unknown>,
) => Promise<CommandAck>;

interface SandoRewindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dispatch: SandoRewindDispatch;
  /** A turn is running: the server refuses rewinds until it stops. */
  busy: boolean;
}

const SCOPES: SandoRewindScope[] = ["both", "conversation", "files"];

export function SandoRewindDialog({ open, onOpenChange, dispatch, busy }: SandoRewindDialogProps) {
  const { intl } = useZCodeIntl();
  const t = useCallback(
    (id: string, values?: Record<string, string>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const [points, setPoints] = useState<SandoRewindPointWire[]>([]);
  const [undo, setUndo] = useState<SandoRewindUndoInfoWire | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState<SandoRewindScope>("both");
  const [result, setResult] = useState<SandoRewindCommandResult | null>(null);

  const describeFailure = useCallback(
    (reasonCode: string, message?: string) =>
      reasonCode === "guard.rewindWhileRunning"
        ? t("sando.rewind.busy")
        : `${t("sando.rewind.failed")}${message ? ` ${message}` : ` (${reasonCode})`}`,
    [t],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const outcome = readRewindListAck(await dispatch("listRewindPoints", {}));
      if (!outcome.ok) {
        setError(describeFailure(outcome.reasonCode, outcome.message));
        return;
      }
      const ordered = newestFirst(outcome.points);
      setPoints(ordered);
      setUndo(outcome.undo);
      setSelected((current) =>
        current && ordered.some((point) => point.messageId === current)
          ? current
          : (ordered[0]?.messageId ?? null),
      );
    } catch (caught) {
      setError(describeFailure("fault.transport", caught instanceof Error ? caught.message : undefined));
    } finally {
      setLoading(false);
    }
  }, [describeFailure, dispatch]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setResult(null);
    void reload();
  }, [open, reload]);

  const point = useMemo(
    () => points.find((candidate) => candidate.messageId === selected) ?? null,
    [points, selected],
  );

  const run = useCallback(
    async (type: "rewindToTurn" | "undoRewind", payload: Record<string, unknown>) => {
      setWorking(true);
      setError(null);
      try {
        const outcome = readRewindActionAck(await dispatch(type, payload));
        if (!outcome.ok) {
          setError(describeFailure(outcome.reasonCode, outcome.message));
          return;
        }
        setResult(outcome.result);
        setUndo(outcome.result.undo);
        await reload();
      } catch (caught) {
        setError(describeFailure("fault.transport", caught instanceof Error ? caught.message : undefined));
      } finally {
        setWorking(false);
      }
    },
    [describeFailure, dispatch, reload],
  );

  const rewind = (force: boolean) => {
    if (!point) return;
    void run("rewindToTurn", {
      targetMessageId: point.messageId,
      scope,
      ...(force ? { force: true } : {}),
    });
  };

  const coverage = point ? rewindCoverage(point, scope) : null;
  const disabled = busy || working || loading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="sando-rewind-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HistoryIcon className="size-4" />
            {t("sando.rewind.title")}
          </DialogTitle>
          <DialogDescription>{t("sando.rewind.description")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label={t("sando.rewind.scopeLabel")}>
            {SCOPES.map((value) => (
              <Button
                key={value}
                type="button"
                role="radio"
                aria-checked={scope === value}
                variant={scope === value ? "secondary" : "outline"}
                className={cn("min-h-11 text-ui-sm", scope === value && "border-brand")}
                onClick={() => setScope(value)}
              >
                {t(`sando.rewind.scope.${value}`)}
              </Button>
            ))}
          </div>

          <div
            className="grid max-h-[40vh] gap-1 overflow-y-auto pr-1"
            role="radiogroup"
            aria-label={t("sando.rewind.turnsLabel")}
          >
            {loading && points.length === 0 ? (
              <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
                <Loader2Icon className="size-3.5 animate-spin" />
                {t("sando.rewind.loading")}
              </div>
            ) : points.length === 0 ? (
              <p className="text-ui-base text-foreground-subtle">{t("sando.rewind.empty")}</p>
            ) : (
              points.map((candidate) => {
                const active = candidate.messageId === selected;
                return (
                  <button
                    key={candidate.messageId}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setSelected(candidate.messageId)}
                    className={cn(
                      "grid min-h-11 gap-0.5 rounded-md border px-2 py-1.5 text-left",
                      active
                        ? "border-brand bg-card-selected"
                        : "border-border bg-input/30 hover:border-border-hover",
                    )}
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">
                        #{candidate.turn}
                      </span>
                      <span className="min-w-0 truncate text-ui-sm text-foreground">{candidate.preview}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-2 text-ui-xs text-foreground-subtle">
                      <span className="truncate">
                        {candidate.editCount > 0
                          ? t("sando.rewind.edits", {
                              count: String(candidate.editCount),
                              files: candidate.editedFiles.slice(0, 3).join(", "),
                            })
                          : t("sando.rewind.noEdits")}
                      </span>
                      {candidate.shellCommandCount > 0 ? (
                        <span className="flex shrink-0 items-center gap-1 text-warning">
                          <TerminalIcon className="size-3" />
                          {t("sando.rewind.shellCount", { count: String(candidate.shellCommandCount) })}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {point && coverage ? (
            <p className="text-ui-sm text-foreground-subtle">
              {t(`sando.rewind.summary.${scope}`, {
                turn: String(point.turn),
                edits: String(coverage.fileEdits),
              })}
            </p>
          ) : null}

          {coverage && coverage.shellCommands > 0 ? (
            <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-ui-sm text-foreground">
              <TerminalIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>{t("sando.rewind.shellWarning", { count: String(coverage.shellCommands) })}</span>
            </div>
          ) : (
            <p className="text-ui-xs text-foreground-subtlest">{t("sando.rewind.shellNote")}</p>
          )}

          {busy ? <p className="text-ui-sm text-warning">{t("sando.rewind.busy")}</p> : null}
          {error ? <p className="text-ui-sm text-danger">{error}</p> : null}

          {result ? (
            <div className="grid gap-1 rounded-md border border-border bg-surface px-2 py-1.5" aria-live="polite">
              <p className="whitespace-pre-wrap text-ui-sm text-foreground">{result.response}</p>
              {result.skippedFiles.length > 0 ? (
                <ul className="grid gap-0.5">
                  {result.skippedFiles.map((file) => (
                    <li key={file.path} className="flex justify-between gap-2 text-ui-xs text-foreground-subtle">
                      <span className="min-w-0 truncate font-mono">{file.path}</span>
                      <span className="shrink-0">
                        {t(REWIND_IGNORED_REASON_KEYS[file.reason] ?? REWIND_IGNORED_REASON_KEYS.unsupported_checkpoint!)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {canForce(result) ? (
                <Button
                  type="button"
                  variant="warning"
                  className="min-h-11 justify-self-start"
                  disabled={disabled}
                  onClick={() => rewind(true)}
                >
                  {t("sando.rewind.force")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={disabled || !undo}
            title={undo ? undo.label : undefined}
            onClick={() => void run("undoRewind", {})}
          >
            <Undo2Icon />
            {undo?.kind === "undo" ? t("sando.rewind.redo") : t("sando.rewind.undo")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11"
            disabled={disabled || !point}
            onClick={() => rewind(false)}
          >
            {working ? <Loader2Icon className="animate-spin" /> : <HistoryIcon />}
            {point ? t("sando.rewind.confirm", { turn: String(point.turn) }) : t("sando.rewind.title")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
