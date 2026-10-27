// Sando (ShrineTech): VERBATIM copy of the Planner's client/src/lib/chartSpec.js (2026-10-27) — keep the two identical;
// change it there first, then copy. Types: chartSpec.d.ts.
// ```chart and ```flow blocks — small data charts and status flows inside a chat reply (Chat, Dive In, /lily; 2026-10-27).
// Pure helpers (no DOM, no React) so node tests and Sando's workbench can use the same file: parse the JSON specs, nice
// scales, number formatting. lib/chartRender.js draws the SVG (lazy chunk); lib/richBlocks.js draws flows.
//
//   ```chart {"type": "line" | "bar" | "area" | "scatter" | "donut", "title": "…", "unit": "ms", "yLabel": "…",
//             "x": ["Mon", "Tue", …],                       (line / bar / area: category or time labels)
//             "series": [{"name": "p50", "data": [120, 98, …]}, …]}
//     scatter: "series": [{"name": "…", "data": [[x, y], …]}], optional "xLabel"
//     donut:   "x": ["Done", "Open", …], "series": [{"data": [12, 5, …]}]   (or "slices": [{"label", "value"}])
//   ```flow  {"title": "…", "steps": [{"label": "Render", "status": "done" | "active" | "blocked" | "todo", "note": "…"}]}
//
// Colour is the job of the renderer (CSS --viz-1..8, validated with the dataviz method); a spec never carries hex.

export const CHART_TYPES = new Set(['line', 'bar', 'area', 'scatter', 'donut']);
export const MAX_SERIES = 8;          // categorical palette size: a 9th hue is never generated
export const MAX_SCATTER_SERIES = 3;  // only the first three slots separate under all-pairs (scatter)
export const MAX_DONUT_SLICES = 6;    // the rest fold into "Other"
export const MAX_POINTS = 500;

const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(+v) ? +v : null));
const str = (v, max = 120) => String(v ?? '').slice(0, max);

function parseJson(src) {
  try { return { raw: JSON.parse(String(src || '')) }; } catch (e) { return { error: `not valid JSON (${e.message})` }; }
}

/** → { ok: true, chart } | { ok: false, error }. */
export function parseChartSpec(src) {
  const p = parseJson(src);
  if (p.error) return { ok: false, error: p.error };
  const raw = p.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'needs a JSON object' };
  let type = String(raw.type || raw.kind || 'line').toLowerCase();
  if (type === 'pie' || type === 'doughnut') type = 'donut';
  if (type === 'column') type = 'bar';
  if (!CHART_TYPES.has(type)) return { ok: false, error: `unknown type "${type}" (line, bar, area, scatter, donut)` };
  const base = {
    type,
    title: str(raw.title || ''),
    unit: str(raw.unit || '', 16),
    yLabel: str(raw.yLabel || raw.y_label || '', 60),
    xLabel: str(raw.xLabel || raw.x_label || '', 60),
    note: str(raw.note || raw.caption || '', 240),
    notes: [],
  };

  if (type === 'donut') {
    let labels;
    let values;
    if (Array.isArray(raw.slices)) {
      labels = raw.slices.map((s) => str(s?.label ?? s?.name ?? ''));
      values = raw.slices.map((s) => num(s?.value));
    } else {
      labels = (Array.isArray(raw.x) ? raw.x : Array.isArray(raw.labels) ? raw.labels : []).map((l) => str(l));
      values = (Array.isArray(raw.series?.[0]?.data) ? raw.series[0].data : Array.isArray(raw.data) ? raw.data : []).map(num);
    }
    let slices = labels.map((label, i) => ({ label: label || `#${i + 1}`, value: values[i] })).filter((s) => s.value !== null && s.value > 0);
    if (slices.length < 2) return { ok: false, error: 'a donut needs at least 2 positive values' };
    slices.sort((a, b) => b.value - a.value);   // largest first, so Other takes the smallest
    if (slices.length > MAX_DONUT_SLICES) {
      const keep = slices.slice(0, MAX_DONUT_SLICES - 1);
      const rest = slices.slice(MAX_DONUT_SLICES - 1);
      keep.push({ label: 'Other', value: rest.reduce((a, s) => a + s.value, 0), other: rest.length });
      base.notes.push(`${rest.length} smaller slices folded into Other`);
      slices = keep;
    }
    return { ok: true, chart: { ...base, slices, total: slices.reduce((a, s) => a + s.value, 0) } };
  }

  const rawSeries = Array.isArray(raw.series) ? raw.series
    : Array.isArray(raw.data) ? [{ name: raw.name || raw.yLabel || '', data: raw.data }] : [];
  let series = rawSeries.filter((s) => s && typeof s === 'object' && Array.isArray(s.data))
    .map((s, i) => ({ name: str(s.name ?? s.label ?? (rawSeries.length > 1 ? `Series ${i + 1}` : ''), 60), data: s.data.slice(0, MAX_POINTS) }));
  if (!series.length) return { ok: false, error: 'needs a "series" list with "data"' };
  const cap = type === 'scatter' ? MAX_SCATTER_SERIES : MAX_SERIES;
  if (series.length > cap) {
    base.notes.push(`showing the first ${cap} of ${series.length} series`);
    series = series.slice(0, cap);
  }

  if (type === 'scatter') {
    series = series.map((s) => ({
      name: s.name,
      points: s.data.map((d) => (Array.isArray(d) ? [num(d[0]), num(d[1]), d[2] != null ? str(d[2], 60) : '']
        : d && typeof d === 'object' ? [num(d.x), num(d.y), d.label != null ? str(d.label, 60) : ''] : [null, null, '']))
        .filter(([x, y]) => x !== null && y !== null),
    })).filter((s) => s.points.length);
    if (!series.length) return { ok: false, error: 'scatter data must be [x, y] pairs' };
    return { ok: true, chart: { ...base, series } };
  }

  const xIn = Array.isArray(raw.x) ? raw.x : Array.isArray(raw.labels) ? raw.labels : Array.isArray(raw.categories) ? raw.categories : null;
  // Given labels set the length (a longer data list is cut, a shorter one leaves gaps); else the longest series does.
  const n = xIn && xIn.length ? xIn.length : Math.max(...series.map((s) => s.data.length));
  const x = Array.from({ length: Math.min(n, MAX_POINTS) }, (_, i) => str(xIn?.[i] ?? i + 1, 40));
  series = series.map((s) => ({ name: s.name, values: x.map((_, i) => num(s.data[i])) }));
  if (!series.some((s) => s.values.some((v) => v !== null))) return { ok: false, error: 'no numeric values' };
  if (type === 'bar' && x.length * series.length > 120) base.notes.push('many bars: a line chart may read better');
  return { ok: true, chart: { ...base, x, series } };
}

/** Nice axis: → { min, max, step, ticks }. includeZero for bars/areas (bars grow from one baseline). */
export function niceScale(lo, hi, { includeZero = false, count = 5 } = {}) {
  let a = Number.isFinite(lo) ? lo : 0;
  let b = Number.isFinite(hi) ? hi : 1;
  if (includeZero) { a = Math.min(a, 0); b = Math.max(b, 0); }
  if (a === b) { if (a === 0) b = 1; else { const d = Math.abs(a) * 0.5; a -= d; b += d; if (includeZero) { a = Math.min(a, 0); b = Math.max(b, 0); } } }
  const raw = (b - a) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const min = Math.floor(a / step + 1e-9) * step;
  const max = Math.ceil(b / step - 1e-9) * step;
  const ticks = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : +v.toPrecision(12));
  return { min, max, step, ticks };
}

/** Short, readable number: 1234 → "1.2k", 0.0042 → "0.0042", with the unit. */
export function formatValue(v, unit = '') {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  let s;
  if (a >= 1e9) s = `${+(v / 1e9).toFixed(1)}B`;
  else if (a >= 1e6) s = `${+(v / 1e6).toFixed(1)}M`;
  else if (a >= 1e4) s = `${+(v / 1e3).toFixed(1)}k`;
  else if (a >= 100 || Number.isInteger(v)) s = String(Math.round(v * 100) / 100);
  else if (a >= 1) s = String(+v.toFixed(2));
  else s = String(+v.toPrecision(2));
  if (!unit) return s;
  return unit === '%' ? `${s}%` : `${s} ${unit}`;
}

/** Every value of a chart as table rows (the always-available reading path): → { head: [...], rows: [[...]] }. */
export function chartTable(chart) {
  const u = chart.unit;
  if (chart.type === 'donut') {
    return { head: ['', 'Value', 'Share'], rows: chart.slices.map((s) => [s.label, formatValue(s.value, u), `${((s.value / chart.total) * 100).toFixed(1)}%`]) };
  }
  if (chart.type === 'scatter') {
    const rows = [];
    for (const s of chart.series) for (const [x, y, l] of s.points) rows.push([s.name || '', l || '', formatValue(x), formatValue(y, u)]);
    return { head: ['Series', 'Point', chart.xLabel || 'x', chart.yLabel || 'y'], rows };
  }
  return {
    head: [chart.xLabel || '', ...chart.series.map((s, i) => s.name || (chart.series.length > 1 ? `Series ${i + 1}` : chart.yLabel || 'Value'))],
    rows: chart.x.map((x, i) => [x, ...chart.series.map((s) => formatValue(s.values[i], u))]),
  };
}

// ── ```flow ────────────────────────────────────────────────────────────────
export const FLOW_STATUSES = ['done', 'active', 'blocked', 'todo'];
const FLOW_ALIASES = {
  done: 'done', complete: 'done', completed: 'done', ok: 'done', passed: 'done',
  active: 'active', running: 'active', in_progress: 'active', 'in progress': 'active', doing: 'active', now: 'active',
  blocked: 'blocked', failed: 'blocked', error: 'blocked', stuck: 'blocked',
  todo: 'todo', pending: 'todo', queued: 'todo', next: 'todo', waiting: 'todo',
};

/** → { ok: true, flow } | { ok: false, error }. Unknown statuses read as todo. */
export function parseFlowSpec(src) {
  const p = parseJson(src);
  if (p.error) return { ok: false, error: p.error };
  let raw = p.raw;
  if (Array.isArray(raw)) raw = { steps: raw };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps) || !raw.steps.length) return { ok: false, error: 'needs a "steps" list' };
  const steps = raw.steps.slice(0, 40).map((s) => (typeof s === 'string' ? { label: s } : s))
    .filter((s) => s && typeof s === 'object' && (s.label || s.name))
    .map((s) => ({
      label: str(s.label ?? s.name, 120),
      status: FLOW_ALIASES[String(s.status || '').toLowerCase().trim()] || 'todo',
      note: s.note ? str(s.note, 240) : '',
    }));
  if (!steps.length) return { ok: false, error: 'no step has a label' };
  const counts = Object.fromEntries(FLOW_STATUSES.map((k) => [k, steps.filter((s) => s.status === k).length]));
  return { ok: true, flow: { title: str(raw.title || '', 120), updated: str(raw.updated || '', 40), steps, counts } };
}
