// Types for chartSpec.js (verbatim copy of the Planner's file; see its header).
export type ChartType = "line" | "bar" | "area" | "scatter" | "donut";
export interface ChartSlice { label: string; value: number; other?: number }
export interface ChartSeries { name: string; values?: (number | null)[]; points?: [number, number, string][] }
export interface ChartData {
  type: ChartType; title: string; unit: string; yLabel: string; xLabel: string; note: string; notes: string[];
  x?: string[]; series?: ChartSeries[]; slices?: ChartSlice[]; total?: number;
}
export type ChartParse = { ok: true; chart: ChartData } | { ok: false; error: string };
export type FlowStatus = "done" | "active" | "blocked" | "todo";
export interface FlowStep { label: string; status: FlowStatus; note: string }
export interface FlowData { title: string; updated: string; steps: FlowStep[]; counts: Record<FlowStatus, number> }
export type FlowParse = { ok: true; flow: FlowData } | { ok: false; error: string };


export declare const CHART_TYPES: ReadonlySet<string>;
export declare const MAX_SERIES: number;
export declare const MAX_SCATTER_SERIES: number;
export declare const MAX_DONUT_SLICES: number;
export declare const MAX_POINTS: number;
export declare function parseChartSpec(src: string): ChartParse;
export declare function niceScale(lo: number, hi: number, opts?: { includeZero?: boolean; count?: number }): { min: number; max: number; step: number; ticks: number[] };
export declare function formatValue(v: number | null | undefined, unit?: string): string;
export declare function chartTable(chart: ChartData): { head: string[]; rows: string[][] };
export declare const FLOW_STATUSES: FlowStatus[];
export declare function parseFlowSpec(src: string): FlowParse;
