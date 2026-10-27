// Sando (ShrineTech): VERBATIM copy of the Planner's client/src/lib/chartRender.js (2026-10-27) — keep the two identical;
// change it there first, then copy. Types: chartRender.d.ts.
// SVG renderer for ```chart blocks (spec: lib/chartSpec.js). Loaded lazily by lib/richBlocks.js on the first chart.
// No chart library: line / bar / area / scatter / donut in plain SVG, following the dataviz method — 2px lines, ≤24px bars
// with a 4px rounded data end, 2px surface gaps and rings, hairline solid grid, one y axis, legend for ≥2 series, direct
// end labels on roomy line charts, a hover/keyboard readout (one tooltip, every series), and a table view elsewhere.
// Colours come from CSS (--viz-1..8 on .rich-chart, richBlocks.css). Every label goes in with textContent.
import { niceScale, formatValue } from './chartSpec.js';

const NS = 'http://www.w3.org/2000/svg';
const FONT = 11;
const CHAR_W = 6.4;   // ≈ width per character at 11px IBM Plex Sans, for layout before anything is in the DOM

function svgEl(tag, attrs = {}, style = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  Object.assign(n.style, style);
  return n;
}
function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const color = (i) => `var(--viz-${(i % 8) + 1})`;
const textW = (s) => String(s).length * CHAR_W;

/** Path for a bar with a 4px rounded data end and a square baseline (works for negative values). */
function barPath(x, w, y0, y1) {
  const up = y1 <= y0;
  const len = Math.abs(y0 - y1);
  const r = Math.min(4, len, w / 2);
  if (len < 0.5) return `M${x},${y0}h${w}v0.5h${-w}Z`;
  if (up) return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

function legend(chart, kind) {
  const items = chart.type === 'donut'
    ? chart.slices.map((s, i) => ({ name: `${s.label} · ${formatValue(s.value, chart.unit)} (${((s.value / chart.total) * 100).toFixed(0)}%)`, i }))
    : chart.series.map((s, i) => ({ name: s.name || `Series ${i + 1}`, i }));
  if (chart.type !== 'donut' && items.length < 2) return null;
  const box = h('div', 'pp-chart__legend');
  for (const it of items) {
    const row = h('span', 'pp-chart__key');
    const sw = h('span', `pp-chart__swatch pp-chart__swatch--${kind}`);
    sw.style.setProperty('--c', color(it.i));
    row.append(sw, document.createTextNode(it.name));
    box.append(row);
  }
  return box;
}

function tooltip(wrap) {
  const tip = h('div', 'pp-chart__tip');
  tip.hidden = true;
  wrap.append(tip);
  return {
    show(title, rows, px, py) {
      tip.replaceChildren();
      if (title) tip.append(h('div', 'pp-chart__tip-title', title));
      for (const r of rows) {
        const line = h('div', 'pp-chart__tip-row');
        const key = h('span', 'pp-chart__tip-key');
        key.style.setProperty('--c', color(r.i));
        line.append(key, h('strong', 'pp-chart__tip-val', r.value));
        if (r.name) line.append(h('span', 'pp-chart__tip-name', r.name));
        tip.append(line);
      }
      tip.hidden = false;
      const W = wrap.clientWidth;
      const tw = tip.offsetWidth;
      let left = px + 12;
      if (left + tw > W - 4) left = Math.max(4, px - tw - 12);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, py - 10)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

// ── cartesian: line / area / bar ───────────────────────────────────────────
function drawCartesian(wrap, chart, W) {
  const { type, x, series, unit } = chart;
  const n = x.length;
  const vals = series.flatMap((s) => s.values).filter((v) => v !== null);
  const sc = niceScale(Math.min(...vals), Math.max(...vals), { includeZero: type !== 'line' || Math.min(...vals) >= 0 && Math.min(...vals) < Math.max(...vals) * 0.5 });
  const tickLabels = sc.ticks.map((t) => formatValue(t, unit === '%' ? '%' : ''));
  const roomy = W >= 420;
  const directLabels = type === 'line' && series.length >= 2 && series.length <= 4 && roomy;
  const endNames = directLabels ? series.map((s) => s.name || '') : [];
  const H = Math.round(Math.min(320, Math.max(190, W * 0.5)));
  const m = {
    l: Math.max(...tickLabels.map(textW)) + 10,
    r: directLabels ? Math.min(140, Math.max(...endNames.map(textW)) + 16) : 12,
    t: 10,
    b: 24 + (chart.xLabel ? 14 : 0),
  };
  const pw = Math.max(40, W - m.l - m.r);
  const ph = H - m.t - m.b;
  const y = (v) => m.t + ph - ((v - sc.min) / (sc.max - sc.min)) * ph;
  const band = pw / Math.max(1, n);
  const xAt = type === 'bar'
    ? (i) => m.l + band * i + band / 2
    : (i) => (n === 1 ? m.l + pw / 2 : m.l + (pw * i) / (n - 1));

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', tabindex: 0,
    'aria-label': `${chart.title || type + ' chart'}. ${series.length} series, ${n} points. Use the Table button for every value.` }, { display: 'block', maxWidth: '100%' });
  // grid + y ticks
  sc.ticks.forEach((t, i) => {
    const yy = Math.round(y(t)) + 0.5;
    svg.append(svgEl('line', { x1: m.l, x2: m.l + pw, y1: yy, y2: yy }, { stroke: t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)', strokeWidth: 1 }));
    const lab = svgEl('text', { x: m.l - 8, y: yy + 3.5, 'text-anchor': 'end', 'font-size': FONT }, { fill: 'var(--viz-text-muted)' });
    lab.textContent = tickLabels[i];
    svg.append(lab);
  });
  // x labels, thinned to fit
  const maxLab = Math.max(...x.map(textW), 8);
  // Edge labels hang inward (start/end anchors), so leave a label and a half of room between shown labels.
  const every = Math.max(1, Math.ceil((maxLab * (type === 'bar' ? 1.1 : 1.5) + 12) / Math.max(1, type === 'bar' ? band : pw / Math.max(1, n - 1))));
  const shown = [];
  for (let i = 0; i < n; i += every) shown.push(i);
  if (shown[shown.length - 1] !== n - 1) {
    if (n - 1 - shown[shown.length - 1] < every && shown.length > 1) shown[shown.length - 1] = n - 1;
    else shown.push(n - 1);
  }
  for (const i of shown) {
    const anchor = type === 'bar' || n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    const t = svgEl('text', { x: xAt(i), y: m.t + ph + 16, 'text-anchor': anchor, 'font-size': FONT }, { fill: 'var(--viz-text-muted)' });
    t.textContent = x[i];
    svg.append(t);
  }
  if (chart.xLabel) {
    const t = svgEl('text', { x: m.l + pw / 2, y: H - 2, 'text-anchor': 'middle', 'font-size': FONT }, { fill: 'var(--viz-text-muted)' });
    t.textContent = chart.xLabel;
    svg.append(t);
  }

  const marks = svgEl('g');
  svg.append(marks);
  if (type === 'bar') {
    const k = series.length;
    const bw = Math.max(2, Math.min(24, (band * 0.72 - 2 * (k - 1)) / k));
    const gw = k * bw + (k - 1) * 2;
    const y0 = y(Math.max(sc.min, Math.min(0, sc.max)));
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (v === null) return;
        const bx = xAt(i) - gw / 2 + si * (bw + 2);
        marks.append(svgEl('path', { d: barPath(bx, bw, y0, y(v)), 'data-i': i }, { fill: color(si) }));
      });
    });
  } else {
    series.forEach((s, si) => {
      const segs = [];
      let cur = [];
      s.values.forEach((v, i) => { if (v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([xAt(i), y(v)]); });
      if (cur.length) segs.push(cur);
      for (const seg of segs) {
        const d = seg.map(([px, py], j) => `${j ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
        if (type === 'area' && seg.length > 1) {
          const base = y(Math.max(sc.min, Math.min(0, sc.max)));
          marks.append(svgEl('path', { d: `${d}L${seg[seg.length - 1][0].toFixed(1)},${base}L${seg[0][0].toFixed(1)},${base}Z` }, { fill: color(si), fillOpacity: series.length > 1 ? 0.16 : 0.24, stroke: 'none' }));
        }
        marks.append(svgEl('path', { d }, { fill: 'none', stroke: color(si), strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }));
        if (seg.length === 1) marks.append(svgEl('circle', { cx: seg[0][0], cy: seg[0][1], r: 4 }, { fill: color(si), stroke: 'var(--viz-surface)', strokeWidth: 2 }));
      }
      // end dot
      const last = s.values.reduce((acc, v, i) => (v !== null ? i : acc), -1);
      if (last >= 0 && type === 'line') marks.append(svgEl('circle', { cx: xAt(last), cy: y(s.values[last]), r: 4 }, { fill: color(si), stroke: 'var(--viz-surface)', strokeWidth: 2 }));
    });
    if (directLabels) {
      const ends = series.map((s, si) => {
        const last = s.values.reduce((acc, v, i) => (v !== null ? i : acc), -1);
        return { si, name: endNames[si], y: last >= 0 ? y(s.values[last]) : null };
      }).filter((e) => e.y !== null && e.name).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
      const over = ends.length ? ends[ends.length - 1].y - (m.t + ph) : 0;
      if (over > 0) ends.forEach((e) => { e.y -= over; });
      for (const e of ends) {
        const t = svgEl('text', { x: m.l + pw + 10, y: e.y + 3.5, 'font-size': FONT }, { fill: 'var(--viz-text)' });
        t.textContent = e.name;
        svg.append(t);
      }
    }
  }

  // hover / keyboard readout: nearest x index; one tooltip lists every series
  const tip = tooltip(wrap);
  const cross = svgEl('line', { y1: m.t, y2: m.t + ph }, { stroke: 'var(--viz-axis)', strokeWidth: 1, display: 'none', pointerEvents: 'none' });
  const hiGroup = svgEl('g', {}, { pointerEvents: 'none' });
  svg.append(cross, hiGroup);
  let idx = -1;
  const showAt = (i) => {
    idx = Math.max(0, Math.min(n - 1, i));
    const cx = xAt(idx);
    hiGroup.replaceChildren();
    if (type === 'bar') {
      marks.querySelectorAll('path').forEach((p) => { p.style.opacity = Number(p.getAttribute('data-i')) === idx ? '1' : '0.45'; });
      cross.style.display = 'none';
    } else {
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
      cross.style.display = '';
      series.forEach((s, si) => {
        const v = s.values[idx];
        if (v !== null) hiGroup.append(svgEl('circle', { cx, cy: y(v), r: 4.5 }, { fill: color(si), stroke: 'var(--viz-surface)', strokeWidth: 2 }));
      });
    }
    const rows = series.map((s, si) => ({ i: si, value: formatValue(s.values[idx], unit), name: series.length > 1 || s.name ? (s.name || `Series ${si + 1}`) : '' }));
    const vs = series.map((s) => s.values[idx]).filter((v) => v !== null);
    const sx = svg.getBoundingClientRect();
    const scale = sx.width ? sx.width / W : 1;
    tip.show(x[idx], rows, cx * scale, (vs.length ? y(Math.max(...vs)) : m.t) * scale);
  };
  const clear = () => {
    idx = -1; cross.style.display = 'none'; hiGroup.replaceChildren(); tip.hide();
    marks.querySelectorAll('path').forEach((p) => { if (type === 'bar') p.style.opacity = '1'; });
  };
  const hit = svgEl('rect', { x: m.l, y: m.t, width: pw, height: ph }, { fill: 'transparent', cursor: 'crosshair' });
  svg.append(hit);
  const fromEvent = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / (r.width || W)) * W;
    return type === 'bar' ? Math.floor((px - m.l) / band) : (n === 1 ? 0 : Math.round(((px - m.l) / pw) * (n - 1)));
  };
  hit.addEventListener('pointermove', (e) => showAt(fromEvent(e)));
  hit.addEventListener('pointerdown', (e) => showAt(fromEvent(e)));
  svg.addEventListener('pointerleave', clear);
  svg.addEventListener('blur', clear);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); showAt(idx < 0 ? 0 : idx + (e.key === 'ArrowRight' ? 1 : -1)); }
    else if (e.key === 'Escape') clear();
  });
  return svg;
}

// ── scatter ────────────────────────────────────────────────────────────────
function drawScatter(wrap, chart, W) {
  const pts = chart.series.flatMap((s, si) => s.points.map(([px, py, l]) => ({ px, py, l, si })));
  const sx = niceScale(Math.min(...pts.map((p) => p.px)), Math.max(...pts.map((p) => p.px)), { count: 5 });
  const sy = niceScale(Math.min(...pts.map((p) => p.py)), Math.max(...pts.map((p) => p.py)), { count: 5 });
  const ylabs = sy.ticks.map((t) => formatValue(t));
  const H = Math.round(Math.min(320, Math.max(200, W * 0.55)));
  const m = { l: Math.max(...ylabs.map(textW)) + 10, r: 12, t: 10, b: 24 + (chart.xLabel ? 14 : 0) };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const X = (v) => m.l + ((v - sx.min) / (sx.max - sx.min)) * pw;
  const Y = (v) => m.t + ph - ((v - sy.min) / (sy.max - sy.min)) * ph;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', tabindex: 0,
    'aria-label': `${chart.title || 'scatter chart'}. ${pts.length} points. Use the Table button for every value.` }, { display: 'block', maxWidth: '100%' });
  sy.ticks.forEach((t, i) => {
    const yy = Math.round(Y(t)) + 0.5;
    svg.append(svgEl('line', { x1: m.l, x2: m.l + pw, y1: yy, y2: yy }, { stroke: 'var(--viz-grid)', strokeWidth: 1 }));
    const lab = svgEl('text', { x: m.l - 8, y: yy + 3.5, 'text-anchor': 'end', 'font-size': FONT }, { fill: 'var(--viz-text-muted)' });
    lab.textContent = ylabs[i];
    svg.append(lab);
  });
  const every = Math.max(1, Math.ceil((Math.max(...sx.ticks.map((t) => textW(formatValue(t)))) + 12) / (pw / Math.max(1, sx.ticks.length - 1))));
  sx.ticks.forEach((t, i) => {
    if (i % every) return;
    const lab = svgEl('text', { x: X(t), y: m.t + ph + 16, 'text-anchor': 'middle', 'font-size': FONT }, { fill: 'var(--viz-text-muted)' });
    lab.textContent = formatValue(t);
    svg.append(lab);
  });
  if (chart.xLabel) {
    const t = svgEl('text', { x: m.l + pw / 2, y: H - 2, 'text-anchor': 'middle', 'font-size': FONT }, { fill: 'var(--viz-text-muted)' });
    t.textContent = chart.xLabel;
    svg.append(t);
  }
  for (const p of pts) svg.append(svgEl('circle', { cx: X(p.px), cy: Y(p.py), r: 4 }, { fill: color(p.si), stroke: 'var(--viz-surface)', strokeWidth: 2 }));
  const tip = tooltip(wrap);
  const ring = svgEl('circle', { r: 7 }, { fill: 'none', stroke: 'var(--viz-text)', strokeWidth: 1.5, display: 'none', pointerEvents: 'none' });
  svg.append(ring);
  const hit = svgEl('rect', { x: 0, y: 0, width: W, height: H }, { fill: 'transparent' });
  svg.append(hit);
  let cur = -1;
  const show = (k) => {
    cur = k;
    const p = pts[k];
    ring.setAttribute('cx', X(p.px)); ring.setAttribute('cy', Y(p.py)); ring.style.display = '';
    const r = svg.getBoundingClientRect();
    const s = r.width ? r.width / W : 1;
    tip.show(p.l || '', [{ i: p.si, value: `${formatValue(p.px)}, ${formatValue(p.py, chart.unit)}`, name: chart.series[p.si].name || '' }], X(p.px) * s, Y(p.py) * s);
  };
  const clear = () => { cur = -1; ring.style.display = 'none'; tip.hide(); };
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const s = r.width ? W / r.width : 1;
    const px = (e.clientX - r.left) * s;
    const py = (e.clientY - r.top) * s;
    let best = -1;
    let bd = 24 * 24;   // nearest point within 24px: hit area bigger than the 8px dot
    pts.forEach((p, k) => { const d = (X(p.px) - px) ** 2 + (Y(p.py) - py) ** 2; if (d < bd) { bd = d; best = k; } });
    if (best >= 0) show(best); else clear();
  });
  svg.addEventListener('pointerleave', clear);
  svg.addEventListener('blur', clear);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); show((cur + (e.key === 'ArrowRight' ? 1 : pts.length - 1)) % pts.length); }
    else if (e.key === 'Escape') clear();
  });
  return svg;
}

// ── donut ──────────────────────────────────────────────────────────────────
function drawDonut(wrap, chart, W) {
  const size = Math.min(220, Math.max(150, W * 0.5));
  const R = size / 2 - 2;
  const r0 = R * 0.62;
  const c = size / 2;
  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', tabindex: 0,
    'aria-label': `${chart.title || 'donut chart'}. ${chart.slices.map((s) => `${s.label} ${formatValue(s.value, chart.unit)}`).join(', ')}` }, { display: 'block', margin: '0 auto' });
  const tip = tooltip(wrap);
  let a0 = -Math.PI / 2;
  const paths = [];
  chart.slices.forEach((s, i) => {
    const a1 = a0 + (s.value / chart.total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, a) => `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
    const d = `M${p(R, a0)}A${R},${R} 0 ${large} 1 ${p(R, a1)}L${p(r0, a1)}A${r0},${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
    const path = svgEl('path', { d }, { fill: color(i), stroke: 'var(--viz-surface)', strokeWidth: 2, strokeLinejoin: 'round', cursor: 'pointer' });
    const mid = (a0 + a1) / 2;
    const show = () => {
      paths.forEach((q, k) => { q.style.opacity = k === i ? '1' : '0.5'; });
      const r = svg.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      const sc = r.width ? r.width / size : 1;
      tip.show(s.label, [{ i, value: formatValue(s.value, chart.unit), name: `${((s.value / chart.total) * 100).toFixed(1)}%` }],
        r.left - wr.left + (c + R * 0.8 * Math.cos(mid)) * sc, r.top - wr.top + (c + R * 0.8 * Math.sin(mid)) * sc);
    };
    path.addEventListener('pointerenter', show);
    path.addEventListener('pointerdown', show);
    paths.push(path);
    svg.append(path);
    a0 = a1;
  });
  const total = svgEl('text', { x: c, y: c + 6, 'text-anchor': 'middle', 'font-size': 18, 'font-weight': 600 }, { fill: 'var(--viz-text)' });
  total.textContent = formatValue(chart.total, chart.unit);
  const sub = svgEl('text', { x: c, y: c + 22, 'text-anchor': 'middle', 'font-size': FONT }, { fill: 'var(--viz-text-muted)' });
  sub.textContent = 'total';
  svg.append(total, sub);
  svg.addEventListener('pointerleave', () => { paths.forEach((q) => { q.style.opacity = '1'; }); tip.hide(); });
  return svg;
}

/**
 * Draw `chart` into `host` (an empty element). Re-draws when the host's width changes (phone rotation, side panel).
 * → { destroy }.
 */
export function renderChart(host, chart) {
  const box = h('div', 'pp-chart');
  if (chart.title) box.append(h('div', 'pp-chart__title', chart.title));
  if (chart.yLabel && chart.type !== 'donut' && chart.type !== 'scatter') box.append(h('div', 'pp-chart__ylabel', chart.yLabel + (chart.unit && chart.unit !== '%' ? ` (${chart.unit})` : '')));
  const lg = legend(chart, chart.type === 'line' ? 'line' : chart.type === 'scatter' ? 'dot' : 'rect');
  if (lg) box.append(lg);
  const wrap = h('div', 'pp-chart__plot');
  box.append(wrap);
  for (const t of [chart.note, ...chart.notes].filter(Boolean)) box.append(h('div', 'pp-chart__note', t));
  host.append(box);
  let lastW = 0;
  const draw = () => {
    const W = Math.max(260, Math.floor(wrap.clientWidth || host.clientWidth || 600));
    if (Math.abs(W - lastW) < 24 && lastW) return;
    lastW = W;
    wrap.replaceChildren();
    const svg = chart.type === 'donut' ? drawDonut(wrap, chart, W) : chart.type === 'scatter' ? drawScatter(wrap, chart, W) : drawCartesian(wrap, chart, W);
    wrap.prepend(svg);
  };
  draw();
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { if (wrap.isConnected) draw(); else ro.disconnect(); });
    ro.observe(wrap);
  }
  return { destroy() { ro?.disconnect(); } };
}
