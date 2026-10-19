// Sando native subagents (SANDO-SUBAGENTS.md): parallel cap, result budget, files touched, per-call model and turn cap.
// Drives the real subagent port and Agent tool handler from dist with a fake child runtime (no model, no GPU).
// Run: pnpm --filter @zcode/core build && pnpm exec tsx --test test/sando-subagents.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createSubagentSlotGate, resolveSubagentMaxParallel } = await import(
  "../dist/subagent/slot-gate.js"
);
const { budgetSubagentResult, truncateUtf8, formatFilesTouched, resolveSubagentResultMaxBytes } =
  await import("../dist/subagent/result-budget.js");
const { createFilesTouchedCollector } = await import("../dist/subagent/files-touched.js");
const { createExploreSubagentPort } = await import("../dist/subagent/runner.js");
const { agentToolEntry } = await import("../dist/tool/handlers/agent.js");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-subagents-"));
process.on("exit", () => fs.rmSync(base, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("slot gate: never more than the cap at once, FIFO, abort leaves the queue", async () => {
  const gate = createSubagentSlotGate(2);
  let active = 0;
  let peak = 0;
  const order = [];
  const job = (name, ms) => () =>
    gate.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(name);
      await sleep(ms);
      active -= 1;
      return name;
    });
  const aborted = new AbortController();
  const runs = [job("a", 40)(), job("b", 40)(), job("c", 10)(), job("d", 10)()];
  const cancelled = gate.run(async () => "never", { signal: aborted.signal });
  await sleep(5);
  assert.equal(gate.active(), 2);
  assert.equal(gate.queued(), 3);
  aborted.abort(new Error("parent turn cancelled"));
  await assert.rejects(cancelled, /parent turn cancelled/);
  assert.equal(gate.queued(), 2);
  assert.deepEqual(await Promise.all(runs), ["a", "b", "c", "d"]);
  assert.equal(peak, 2);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  assert.equal(gate.active(), 0);
});

test("slot gate: a failing child frees its slot; knob parsing", async () => {
  const gate = createSubagentSlotGate(1);
  await assert.rejects(gate.run(async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(gate.active(), 0);
  assert.equal(resolveSubagentMaxParallel(undefined), 2);
  assert.equal(resolveSubagentMaxParallel("3"), 3);
  assert.equal(resolveSubagentMaxParallel(0), 2);
});

test("result budget: short text untouched, long text cut with a note and saved in full", async () => {
  const resultFile = path.join(base, "budget", "result.md");
  const short = await budgetSubagentResult("all good", { maxBytes: 1000, resultFile });
  assert.deepEqual(short, { text: "all good", truncated: false });
  assert.equal(fs.existsSync(resultFile), false);

  const long = "ANSWER FIRST. " + "détail ".repeat(400);
  const cut = await budgetSubagentResult(long, { maxBytes: 600, resultFile });
  assert.equal(cut.truncated, true);
  assert.equal(cut.resultFile, resultFile);
  assert.ok(Buffer.byteLength(cut.text, "utf8") <= 600, `got ${Buffer.byteLength(cut.text)}`);
  assert.ok(cut.text.startsWith("ANSWER FIRST."));
  assert.match(cut.text, /cut to the 600-byte budget/);
  assert.match(cut.text, new RegExp(resultFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(fs.readFileSync(resultFile, "utf8"), long);
  // never splits a multi-byte character
  assert.equal(truncateUtf8("éé", 3), "é");
  assert.equal(resolveSubagentResultMaxBytes(undefined), 6000);
  assert.equal(resolveSubagentResultMaxBytes(10), 6000);
});

test("files touched: successful writes only, workspace-relative, Bash ignored", () => {
  const ws = "/w/proj";
  const c = createFilesTouchedCollector(ws);
  const sched = (id, toolName, input) => ({
    type: "tool_call_scheduled",
    payload: { toolCallId: id, toolName, input },
  });
  const ok = (id) => ({ type: "tool_call_result", payload: { toolCallId: id, result: { success: true } } });
  const fail = (id) => ({ type: "tool_call_result", payload: { toolCallId: id, result: { success: false } } });
  const err = (id) => ({ type: "tool_call_error", payload: { toolCallId: id, error: {} } });
  c.observe(sched("1", "Write", { file_path: "/w/proj/src/a.ts" }));
  c.observe(sched("2", "Edit", { file_path: "/etc/hosts" }));
  c.observe(sched("3", "Edit", { file_path: "src/b.ts" }));
  c.observe(sched("4", "Bash", { command: "echo > c.ts" }));
  c.observe(sched("5", "Write", { file_path: "/w/proj/src/a.ts" }));
  c.observe(sched("6", "NotebookEdit", { notebook_path: "/w/proj/n.ipynb" }));
  c.observe(ok("1"));
  c.observe(err("2"));
  c.observe(fail("3"));
  c.observe(ok("4"));
  c.observe(ok("5"));
  c.observe(ok("6"));
  assert.deepEqual(c.list(), ["src/a.ts", "n.ipynb"]);
  const many = Array.from({ length: 23 }, (_, i) => `f${i}`);
  assert.match(formatFilesTouched(many), /f19 \(\+3 more\)$/);
  assert.equal(formatFilesTouched([]), "none");
});

function makePort({ maxParallel, resultMaxBytes, profiles, childMs = 30, response } = {}) {
  const calls = [];
  let active = 0;
  let peak = 0;
  const port = createExploreSubagentPort({
    outputRootDir: path.join(base, "agents"),
    maxParallel,
    resultMaxBytes,
    profiles,
    emitParentEvent: async () => {},
    runExploreAgent: async (request) => {
      calls.push(request);
      active += 1;
      peak = Math.max(peak, active);
      await request.onSessionReady?.();
      await sleep(childMs);
      active -= 1;
      return {
        response: response ?? `done: ${request.description}`,
        traceId: request.traceContext.traceId,
        events: [],
        model: request.modelSelection
          ? `${request.modelSelection.providerId}/${request.modelSelection.modelId}`
          : "parent/model",
        filesTouched: ["src/x.ts"],
        turnCap: request.maxTurns ?? 30,
      };
    },
  });
  return { port, calls, peak: () => peak };
}

let n = 0;
const launchRequest = (extra = {}) => {
  n += 1;
  return {
    sessionId: "sess_parent",
    turnId: "turn_1",
    parentToolCallId: `call_${n}`,
    agentType: "general-purpose",
    description: `job ${n}`,
    prompt: "do a self-contained job",
    workingDirectory: base,
    workspaceRoot: base,
    trace: { traceId: `trace_${n}`, spanId: `span_${n}`, sessionId: "sess_parent", turnId: "turn_1" },
    ...extra,
  };
};

test("port: three parallel launches run at most two at once and all complete", async () => {
  const { port, peak } = makePort({ maxParallel: 2, childMs: 40 });
  const outputs = await Promise.all([1, 2, 3].map(() => port.launch(launchRequest())));
  assert.equal(peak(), 2);
  for (const out of outputs) {
    assert.equal(out.status, "completed");
    assert.deepEqual(out.filesTouched, ["src/x.ts"]);
    assert.equal(out.model, "parent/model");
  }
});

test("port: per-call model and max_turns reach the child; max_turns only lowers the profile cap", async () => {
  const profiles = [
    { name: "capped", description: "capped agent", source: "project", systemPrompt: "x", maxTurns: 5 },
  ];
  const { port, calls } = makePort({ profiles });
  const out = await port.launch(
    launchRequest({
      agentType: "capped",
      modelSelection: { providerId: "fake-b", modelId: "model-b" },
      maxTurns: 50,
    }),
  );
  assert.equal(calls[0].maxTurns, 5, "call asked for 50 but the profile allows 5");
  assert.deepEqual(calls[0].modelSelection, { providerId: "fake-b", modelId: "model-b" });
  assert.equal(out.model, "fake-b/model-b");
  assert.equal(out.turnCap, 5);
  await port.launch(launchRequest({ agentType: "capped", maxTurns: 2 }));
  assert.equal(calls[1].maxTurns, 2);
});

test("port: a long child answer comes back cut to the budget with the full text on disk", async () => {
  const response = "RESULT: fixed the bug.\n" + "x".repeat(5000);
  const { port } = makePort({ resultMaxBytes: 1000, response });
  const out = await port.launch(launchRequest());
  const text = out.content.map((b) => b.text).join("");
  assert.ok(Buffer.byteLength(text) <= 1000);
  assert.ok(text.startsWith("RESULT: fixed the bug."));
  assert.equal(out.resultTruncated, true);
  assert.equal(fs.readFileSync(out.resultFile, "utf8"), response);
});

const catalog = {
  listModels: () => [
    { providerId: "fake-a", modelId: "model-a", reasoningLevels: [], current: true },
    { providerId: "fake-b", modelId: "model-b", reasoningLevels: [], current: false },
    { providerId: "off", modelId: "model-off", reasoningLevels: [], current: false, disabledReason: "no key" },
  ],
};

function handlerContext(launches) {
  return {
    sessionId: "sess_parent",
    turnId: "turn_1",
    toolCallId: "call_h",
    workingDirectory: base,
    workspaceRoot: base,
    modelCatalogPort: catalog,
    subagentPort: {
      launch: async (request) => {
        launches.push(request);
        return { status: "completed" };
      },
    },
  };
}

test("Agent tool: `model` resolves through the catalog before any child exists", async () => {
  const launches = [];
  const ctx = handlerContext(launches);
  await agentToolEntry.handler({ description: "d", prompt: "p", model: "model-b", max_turns: 4 }, ctx);
  assert.deepEqual(launches[0].modelSelection, { providerId: "fake-b", modelId: "model-b" });
  assert.equal(launches[0].maxTurns, 4);

  const unknown = await agentToolEntry.handler({ description: "d", prompt: "p", model: "nope/x" }, ctx);
  assert.equal(unknown.result, false);
  assert.match(unknown.message, /agent_model_not_found/);
  assert.match(unknown.message, /fake-b\/model-b/, "the error lists candidates");

  const disabled = await agentToolEntry.handler({ description: "d", prompt: "p", model: "off/model-off" }, ctx);
  assert.equal(disabled.result, false);
  assert.match(disabled.message, /agent_model_disabled/);

  const noCatalog = await agentToolEntry.handler(
    { description: "d", prompt: "p", model: "model-b" },
    { ...ctx, modelCatalogPort: undefined },
  );
  assert.match(noCatalog.message, /agent_model_unavailable/);
  assert.equal(launches.length, 1, "failed resolutions never launch a child");

  await agentToolEntry.handler({ description: "d", prompt: "p" }, ctx);
  assert.equal(launches[1].modelSelection, undefined, "omitted model = profile / parent model");
});

test("Agent tool: the parent sees model, files touched and turn cap in the footer", () => {
  const text = agentToolEntry.formatModelContent({
    status: "completed",
    agentId: "agent_1",
    agentType: "general-purpose",
    description: "d",
    prompt: "p",
    content: [{ type: "text", text: "Fixed it." }],
    totalToolUseCount: 3,
    totalDurationMs: 1200,
    model: "fake-b/model-b",
    filesTouched: ["src/a.ts", "src/b.ts"],
    turnCap: 12,
  });
  assert.match(text, /^Fixed it\./);
  assert.match(text, /model: fake-b\/model-b/);
  assert.match(text, /files_touched: src\/a\.ts, src\/b\.ts/);
  assert.match(text, /turn_cap: 12/);
});
