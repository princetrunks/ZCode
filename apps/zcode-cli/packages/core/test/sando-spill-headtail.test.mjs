// Sando port 1 (dsh study 2026-11-17): the spill preview shows head + tail, and old tool results are pruned to
// head + tail under compaction pressure instead of cleared (SANDO_TOOL_RESULT_PRUNER, SANDO-SPILL-PRUNER.md).
// Run: pnpm test in apps/zcode-cli/packages/core (tsx --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatGenericPersistedOutputContent,
  formatPersistedOutputEnvelope,
  isPersistedOutputContent,
} from "../src/tool/result-persistence-format.ts";
import {
  MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE,
  maybeLocalMicrocompactMessages,
} from "../src/compact/microcompact.ts";
import {
  pruneToolResultContent,
  resolveToolResultPrunerConfig,
  toolResultPrunerEnabledFromEnv,
} from "../src/compact/tool-result-pruner.ts";

const ERROR_LINE = "error TS2307: Cannot find module './missing.js' (src/app.ts:42:7)";

function buildLog(chars) {
  const lines = [];
  let length = 0;
  for (let i = 0; length < chars; i += 1) {
    const line = `[build] compiling module ${i} ... ok`;
    lines.push(line);
    length += line.length + 1;
  }
  lines.push(ERROR_LINE);
  return lines.join("\n");
}

// ---------- spill preview ----------

test("spill: a 60k-char log with the error on the last line shows that line in the model-visible text", () => {
  const content = buildLog(60_000);
  const out = formatGenericPersistedOutputContent({
    content,
    originalBytes: content.length,
    persistedPath: "/tmp/sando/tool-results/abc.txt",
  });
  assert.ok(isPersistedOutputContent(out));
  assert.ok(out.includes(ERROR_LINE), "tail must carry the final error line");
  assert.ok(out.includes("[build] compiling module 0 ... ok"), "head is kept");
  assert.match(out, /Full output saved to: \/tmp\/sando\/tool-results\/abc\.txt/);
  assert.match(out, /… \d+ chars omitted …/);
  assert.match(out, /Preview \(first 2 KB and last 1 KB\):/);
  assert.ok(out.length < 3_600, `preview stays small (${out.length})`);
});

test("spill: omitted count + head + tail add up to the original; cuts land on line boundaries", () => {
  const content = buildLog(60_000);
  const out = formatPersistedOutputEnvelope({
    content,
    formatBytes: (n) => `${n} B`,
    originalBytes: content.length,
    persistedPath: "/p",
    previewChars: 2_000,
  });
  const body = out.split("\n").slice(4, -1).join("\n");
  const [head, tail] = body.split(/\n… \d+ chars omitted …\n/);
  const omitted = Number(/… (\d+) chars omitted …/.exec(out)[1]);
  assert.equal(head.length + omitted + tail.length, content.length);
  assert.ok(content.startsWith(head));
  assert.ok(content.endsWith(tail));
  assert.ok(tail.startsWith("[build]"), "tail starts at a line start");
  assert.ok(head.endsWith("ok"), "head ends at a line end");
});

test("spill: content within the head budget is shown whole, no marker; tailChars 0 keeps the old head-only shape", () => {
  const short = "line\n".repeat(100);
  const out = formatPersistedOutputEnvelope({
    content: short,
    formatBytes: (n) => `${n} B`,
    originalBytes: 99_999,
    persistedPath: "/p",
    previewChars: 2_000,
  });
  assert.ok(!out.includes("omitted"));
  assert.ok(out.includes("Preview (first 2000 B):"));

  const long = buildLog(10_000);
  const headOnly = formatPersistedOutputEnvelope({
    content: long,
    formatBytes: (n) => `${n} B`,
    originalBytes: long.length,
    persistedPath: "/p",
    previewChars: 2_000,
    tailChars: 0,
  });
  assert.ok(!headOnly.includes(ERROR_LINE));
  assert.match(headOnly, /chars omitted …\n<\/persisted-output>$/);
});

test("spill: rest that fits in the tail budget is shown in full (nothing to omit)", () => {
  const content = "a".repeat(2_500);
  const out = formatPersistedOutputEnvelope({
    content,
    formatBytes: (n) => `${n} B`,
    originalBytes: 2_500,
    persistedPath: "/p",
    previewChars: 2_000,
  });
  assert.ok(out.includes(content));
  assert.ok(!out.includes("omitted"));
});

// ---------- pruner primitives ----------

const prunerOn = resolveToolResultPrunerConfig({ enabled: true });

test("pruner env: unset/on = on, off = off, anything else throws", () => {
  assert.equal(toolResultPrunerEnabledFromEnv({}), true);
  assert.equal(toolResultPrunerEnabledFromEnv({ SANDO_TOOL_RESULT_PRUNER: " On " }), true);
  assert.equal(toolResultPrunerEnabledFromEnv({ SANDO_TOOL_RESULT_PRUNER: "off" }), false);
  assert.equal(toolResultPrunerEnabledFromEnv({ SANDO_TOOL_RESULT_PRUNER: "0" }), false);
  assert.throws(
    () => toolResultPrunerEnabledFromEnv({ SANDO_TOOL_RESULT_PRUNER: "maybe" }),
    /expects on or off/,
  );
});

test("pruner: 8192 cap -> 4096 head + marker + 1024 tail; within cap untouched; idempotent", () => {
  const text = buildLog(20_000);
  const pruned = pruneToolResultContent(text, prunerOn);
  assert.equal(typeof pruned, "string");
  assert.ok(pruned.startsWith(text.slice(0, 4_096)));
  assert.ok(pruned.endsWith(text.slice(-1_024)));
  assert.ok(pruned.includes(ERROR_LINE));
  assert.match(pruned, /… \d+ chars pruned from this old tool result/);
  assert.ok(pruned.length < 8_192);
  assert.equal(pruneToolResultContent(pruned, prunerOn), undefined, "second pass is a no-op");
  assert.equal(pruneToolResultContent("x".repeat(8_192), prunerOn), undefined);
});

test("pruner: text blocks keep order with one marker; media results are never pruned", () => {
  const blocks = [
    { type: "text", text: "A".repeat(5_000) },
    { type: "text", text: "B".repeat(5_000) },
    { type: "text", text: "C".repeat(500) },
  ];
  const pruned = pruneToolResultContent(blocks, prunerOn);
  const joined = pruned.map((b) => b.text).join("");
  assert.ok(joined.startsWith("A".repeat(4_096)));
  assert.ok(joined.endsWith("B".repeat(524) + "C".repeat(500)));
  assert.equal(joined.match(/chars pruned/g).length, 1);
  assert.equal(
    pruneToolResultContent(
      [
        { type: "text", text: "x".repeat(20_000) },
        { type: "image", data: "abc", mediaType: "image/png" },
      ],
      prunerOn,
    ),
    undefined,
  );
});

test("pruner: never splits a surrogate pair", () => {
  const text = "😀".repeat(6_000);
  const pruned = pruneToolResultContent(text, prunerOn);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(pruned));
});

test("pruner config: head + tail + marker must fit under the threshold", () => {
  assert.equal(resolveToolResultPrunerConfig(undefined), undefined);
  assert.equal(resolveToolResultPrunerConfig({ enabled: false }), undefined);
  assert.throws(
    () => resolveToolResultPrunerConfig({ enabled: true, thresholdChars: 5_000 }),
    /must be below thresholdChars/,
  );
});

// ---------- microcompact integration ----------

function conversation(resultCount, resultChars) {
  const messages = [{ role: "user", content: "fix the build" }];
  for (let i = 0; i < resultCount; i += 1) {
    const id = `call_${i}`;
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: "Bash", input: { command: `make step${i}` } }],
    });
    messages.push({
      role: "tool",
      toolCallId: id,
      toolName: "Bash",
      content: `${buildLog(resultChars)}\n(step ${i})`,
    });
  }
  return messages;
}

const toolText = (m) =>
  typeof m.content === "string" ? m.content : m.content.map((b) => b.text).join("");

test("microcompact + pruner: under pressure old results are trimmed to head+tail, the 2 newest are intact", () => {
  const messages = conversation(6, 20_000);
  const result = maybeLocalMicrocompactMessages({
    config: { enabled: false, thresholdTokens: 10_000, pruner: { enabled: true } },
    messages,
  });
  assert.equal(result.decision.reason, "applied");
  assert.equal(result.payload.strategy, "local_tool_result_prune");
  assert.deepEqual(result.payload.prunedToolCallIds, ["call_0", "call_1", "call_2", "call_3"]);
  assert.deepEqual(result.payload.clearedToolCallIds, []);
  assert.deepEqual(result.payload.keptToolCallIds, ["call_4", "call_5"]);
  const tools = result.messages.filter((m) => m.role === "tool");
  for (const [i, m] of tools.entries()) {
    const text = toolText(m);
    assert.ok(text.includes(ERROR_LINE), `result ${i} keeps its error line`);
    assert.ok(text.endsWith(`(step ${i})`));
    if (i < 4) assert.ok(text.length < 8_192);
    else assert.equal(text, toolText(messages[2 + i * 2]));
  }
  assert.ok(result.payload.tokensSaved > 10_000);
});

test("microcompact + pruner: below the pressure threshold nothing happens", () => {
  const result = maybeLocalMicrocompactMessages({
    config: { enabled: false, thresholdTokens: 1_000_000, pruner: { enabled: true } },
    messages: conversation(6, 20_000),
  });
  assert.equal(result.decision.reason, "not_triggered");
  assert.equal(result.payload, undefined);
});

test("pruner off + microcompact off = upstream: disabled, nothing touched", () => {
  const result = maybeLocalMicrocompactMessages({
    config: { enabled: false, thresholdTokens: 10, pruner: { enabled: false } },
    messages: conversation(6, 20_000),
  });
  assert.equal(result.decision.reason, "disabled");
});

test("pruner off + microcompact on = upstream clearing, byte-identical payload shape", () => {
  const result = maybeLocalMicrocompactMessages({
    config: { enabled: true, thresholdTokens: 10_000 },
    messages: conversation(7, 20_000),
  });
  assert.equal(result.payload.strategy, "local_tool_result_clear");
  assert.ok(!("prunedToolCallIds" in result.payload));
  assert.deepEqual(result.payload.clearedToolCallIds, ["call_0", "call_1"]);
  assert.equal(toolText(result.messages[2]), MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE);
});

test("fallback: when pruning is not enough and microcompact is enabled, old results are cleared", () => {
  // 28 pruned (~5.2k chars) + 2 intact (20k) ≈ 188k chars / 3 ≈ 63k tokens, still over 20k -> clear.
  const result = maybeLocalMicrocompactMessages({
    config: { enabled: true, thresholdTokens: 20_000, pruner: { enabled: true } },
    messages: conversation(30, 20_000),
  });
  assert.equal(result.decision.reason, "applied");
  assert.equal(result.payload.clearedToolCallIds.length, 25, "keeps microcompact's 5 newest");
  assert.deepEqual(result.payload.prunedToolCallIds, ["call_25", "call_26", "call_27"]);
  assert.equal(result.payload.strategy, "local_tool_result_prune");
});

test("no fallback when pruning got under the threshold, even with microcompact enabled", () => {
  // before: 6 * 20k chars / 3 ≈ 40k tokens (over 25k); after pruning 4 of them ≈ 20k tokens (under).
  const result = maybeLocalMicrocompactMessages({
    config: { enabled: true, thresholdTokens: 25_000, pruner: { enabled: true } },
    messages: conversation(6, 20_000),
  });
  assert.deepEqual(result.payload.clearedToolCallIds, []);
  assert.equal(result.payload.prunedToolCallIds.length, 4);
});

test("pruner also trims old error results (errors are at the end, the tail keeps them)", () => {
  const messages = conversation(4, 20_000);
  messages[2].isError = true;
  const result = maybeLocalMicrocompactMessages({
    config: { enabled: false, thresholdTokens: 1_000, pruner: { enabled: true } },
    messages,
  });
  assert.ok(result.payload.prunedToolCallIds.includes("call_0"));
  assert.ok(toolText(result.messages[2]).includes(ERROR_LINE));
});
