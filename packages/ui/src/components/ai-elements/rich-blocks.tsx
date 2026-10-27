"use client";

// Sando (ShrineTech): ```chart, ```flow and ```audio blocks in assistant replies (2026-10-27; same contract as the Planner's
// Chat / Dive In / Lily). Specs: lib/chartSpec.ts, lib/audioSpec.ts. The chart SVG renderer (lib/chartRender.ts) is a
// lazy chunk. Every block keeps a "Source" toggle, and a chart has a "Table" view so no value hides behind hover or colour.
// A spec that does not parse shows its message above the plain code block (`fallback`).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { chartTable, parseChartSpec, parseFlowSpec, type FlowStatus } from "@/lib/chartSpec.js";
import { parseAudioSpec } from "@/lib/audioSpec.js";

type ChartRenderModule = typeof import("@/lib/chartRender.js");
let chartModule: Promise<ChartRenderModule> | null = null;
const loadChartRender = (): Promise<ChartRenderModule> => (chartModule ??= import("@/lib/chartRender.js"));

const shellClass = "my-4 overflow-hidden rounded-lg border border-border bg-card text-ui-base";
const barButton =
  "rounded-md border border-border px-2 py-0.5 text-ui-xs text-muted-foreground transition-colors hover:text-foreground " +
  "outline-none focus-visible:ring-2 focus-visible:ring-ring";

function BlockShell({ kind, source, children, extra, showSource, onToggleSource }: {
  kind: string; source: string; children: ReactNode; extra?: ReactNode; showSource: boolean; onToggleSource: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className={shellClass} data-sando-rich={kind}>
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">{kind}</span>
        <button type="button" className={barButton} onClick={onToggleSource}>
          {showSource ? intl.formatMessage({ id: "sando.rich.rendered" }) : intl.formatMessage({ id: "sando.rich.source" })}
        </button>
        {extra}
      </div>
      {showSource ? (
        <pre className="m-0 overflow-x-auto p-3 text-ui-xs text-muted-foreground"><code>{source}</code></pre>
      ) : children}
    </div>
  );
}

function Invalid({ message, fallback }: { message: string; fallback: ReactNode }) {
  return (
    <div className="my-4" data-sando-rich="error">
      <div className="mb-1 text-ui-sm text-muted-foreground">{message}</div>
      {fallback}
    </div>
  );
}

export function ChartBlock({ code, fallback }: { code: string; fallback: ReactNode }) {
  const { intl } = useZCodeIntl();
  const parsed = useMemo(() => parseChartSpec(code), [code]);
  const host = useRef<HTMLDivElement | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!parsed.ok || showSource || showTable || !host.current) return undefined;
    const el = host.current;
    let handle: { destroy(): void } | null = null;
    let live = true;
    loadChartRender().then((m) => {
      if (!live || !el.isConnected) return;
      el.replaceChildren();
      try { handle = m.renderChart(el, parsed.chart); } catch (e) { setFailed(String((e as Error)?.message || e).slice(0, 80)); }
    }).catch(() => setFailed("renderer did not load"));
    return () => { live = false; handle?.destroy(); };
  }, [parsed, showSource, showTable]);

  if (!parsed.ok) return <Invalid message={intl.formatMessage({ id: "sando.rich.chartInvalid" }, { error: parsed.error })} fallback={fallback} />;
  if (failed) return <Invalid message={intl.formatMessage({ id: "sando.rich.chartInvalid" }, { error: failed })} fallback={fallback} />;
  const table = showTable ? chartTable(parsed.chart) : null;
  return (
    <BlockShell
      kind="chart"
      source={code}
      showSource={showSource}
      onToggleSource={() => setShowSource((v) => !v)}
      extra={(
        <button type="button" className={barButton} onClick={() => setShowTable((v) => !v)}>
          {showTable ? intl.formatMessage({ id: "sando.rich.chart" }) : intl.formatMessage({ id: "sando.rich.table" })}
        </button>
      )}
    >
      {table ? (
        <div className="sando-chart overflow-x-auto px-3 py-2">
          {parsed.chart.title ? <div className="mb-1 font-medium text-foreground">{parsed.chart.title}</div> : null}
          <table className="sando-chart__table">
            <thead><tr>{table.head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
            <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div ref={host} className="sando-chart" />
      )}
    </BlockShell>
  );
}

const FLOW_ICON: Record<FlowStatus, string> = { done: "✓", active: "●", blocked: "✕", todo: "○" };

export function FlowBlock({ code, fallback }: { code: string; fallback: ReactNode }) {
  const { intl } = useZCodeIntl();
  const parsed = useMemo(() => parseFlowSpec(code), [code]);
  const [showSource, setShowSource] = useState(false);
  if (!parsed.ok) return <Invalid message={intl.formatMessage({ id: "sando.rich.flowInvalid" }, { error: parsed.error })} fallback={fallback} />;
  const { flow } = parsed;
  const word = (s: FlowStatus) => intl.formatMessage({ id: `sando.rich.flow.${s}` });
  const c = flow.counts;
  const summary = [
    intl.formatMessage({ id: "sando.rich.flow.summary" }, { done: c.done, total: flow.steps.length }),
    c.active ? `${c.active} ${word("active")}` : "",
    c.blocked ? `${c.blocked} ${word("blocked")}` : "",
    flow.updated,
  ].filter(Boolean).join(" · ");
  return (
    <BlockShell kind="flow" source={code} showSource={showSource} onToggleSource={() => setShowSource((v) => !v)}>
      <div className="sando-flow px-3 py-2.5">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          {flow.title ? <div className="font-medium text-foreground">{flow.title}</div> : null}
          <div className="text-ui-xs text-muted-foreground">{summary}</div>
        </div>
        <ol className="sando-flow__steps">
          {flow.steps.map((s, i) => (
            <li key={i} className={cn("sando-flow__step", `is-${s.status}`)}>
              <span className="sando-flow__icon" aria-hidden>{FLOW_ICON[s.status]}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="sando-flow__label">{s.label}</span>
                  <span className="sando-flow__status">{word(s.status)}</span>
                </div>
                {s.note ? <div className="text-ui-xs text-muted-foreground">{s.note}</div> : null}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </BlockShell>
  );
}

let playing: HTMLAudioElement | null = null;   // one clip at a time across the page

export function AudioBlock({ code, fallback }: { code: string; fallback: ReactNode }) {
  const { intl } = useZCodeIntl();
  const parsed = useMemo(() => parseAudioSpec(code), [code]);
  const [showSource, setShowSource] = useState(false);
  const [missing, setMissing] = useState<Record<number, boolean>>({});
  if (!parsed.ok) return <Invalid message={intl.formatMessage({ id: "sando.rich.audioInvalid" }, { error: parsed.error })} fallback={fallback} />;
  return (
    <BlockShell kind="audio" source={code} showSource={showSource} onToggleSource={() => setShowSource((v) => !v)}>
      <div className="flex flex-col gap-2.5 px-3 py-2.5">
        {parsed.title ? <div className="font-medium text-foreground">{parsed.title}</div> : null}
        {parsed.tracks.map((t, i) => (
          <div key={t.url} className="flex min-w-0 flex-col gap-1">
            <div className="text-ui-sm text-muted-foreground break-all">{t.label}</div>
            <audio
              controls
              preload="metadata"
              src={t.url}
              className="h-10 w-full max-w-[480px]"
              onPlay={(e) => { if (playing && playing !== e.currentTarget) playing.pause(); playing = e.currentTarget; }}
              onError={() => setMissing((m) => ({ ...m, [i]: true }))}
            />
            {missing[i] ? <div className="text-ui-xs text-amber-500">{intl.formatMessage({ id: "sando.rich.audioMissing" })}</div> : null}
          </div>
        ))}
      </div>
    </BlockShell>
  );
}
