// Sando: ```chart / ```flow / ```audio (same contract as the Planner). Run: pnpm exec tsx --test packages/ui/test/richBlocks.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { chartTable, formatValue, niceScale, parseChartSpec, parseFlowSpec } from "../src/lib/chartSpec.js";
import { audioUrl, parseAudioSpec, plannerOrigin } from "../src/lib/audioSpec.js";
import { isAudioLanguage, isChartLanguage, isFlowLanguage } from "../src/lib/richFences.js";

test("fence languages", () => {
  assert.ok(isChartLanguage("chart") && isChartLanguage(" Chart "));
  assert.ok(isFlowLanguage("flow") && isAudioLanguage("audio"));
  assert.ok(!isChartLanguage("charts") && !isFlowLanguage("") && !isAudioLanguage(null));
});

test("chart specs parse like the Planner's", () => {
  const r = parseChartSpec(JSON.stringify({ type: "line", unit: "ms", x: ["a", "b"], series: [{ name: "p50", data: [1, "2", 3] }] }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.chart.series?.[0]?.values, [1, 2]);
  assert.deepEqual(chartTable(r.chart).rows, [["a", "1 ms"], ["b", "2 ms"]]);
  assert.equal(parseChartSpec('{"type":"radar","series":[{"data":[1]}]}').ok, false);
  assert.equal(parseChartSpec("{bad").ok, false);
  const many = parseChartSpec(JSON.stringify({ series: Array.from({ length: 9 }, () => ({ data: [1] })) }));
  assert.equal(many.ok && many.chart.series?.length, 8);
  const donut = parseChartSpec(JSON.stringify({ type: "pie", slices: [1, 2, 3, 4, 5, 6, 7].map((v) => ({ label: `s${v}`, value: v })) }));
  assert.ok(donut.ok && donut.chart.slices?.length === 6 && donut.chart.slices[5]?.label === "Other");
  const s = niceScale(3, 97, { includeZero: true });
  assert.deepEqual([s.min, s.max], [0, 100]);
  assert.equal(formatValue(12345, "tok"), "12.3k tok");
});

test("flow specs", () => {
  const f = parseFlowSpec(JSON.stringify([{ label: "a", status: "done" }, { label: "b", status: "running" }, "c", { label: "d", status: "failed" }]));
  assert.ok(f.ok);
  if (!f.ok) return;
  assert.deepEqual(f.flow.steps.map((x) => x.status), ["done", "active", "todo", "blocked"]);
  assert.equal(parseFlowSpec('{"steps":[]}').ok, false);
});

test("audio plays from the Planner on the same site; outside URLs are refused", () => {
  assert.equal(plannerOrigin({ protocol: "https:", hostname: "sando.shrinetech.io" }), "https://projects.shrinetech.io");
  assert.equal(plannerOrigin({ protocol: "http:", hostname: "100.64.1.2" }), "http://100.64.1.2:4001");
  const o = "https://projects.shrinetech.io";
  const u = audioUrl("filler_lora_ab/01_a.wav", o);
  assert.ok(u.ok && u.url === `${o}/api/lily/media/shared?p=filler_lora_ab%2F01_a.wav`);
  for (const bad of ["https://evil.example/a.wav", "javascript:alert(1)", "//evil/a.wav", ""]) assert.equal(audioUrl(bad, o).ok, false, bad);
  const p = parseAudioSpec('{"tracks":[{"src":"x/a.wav","label":"A"},{"src":"http://evil/b.wav"}]}', o);
  assert.ok(p.ok && p.tracks.length === 1 && p.tracks[0]?.label === "A");
});
