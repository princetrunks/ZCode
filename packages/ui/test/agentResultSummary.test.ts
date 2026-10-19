// Sando native subagents: the Agent card's result summary. Run: pnpm exec tsx --test packages/ui/test/agentResultSummary.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { formatAgentDuration, parseAgentResultSummary } from "../src/lib/agentResultSummary.js";

const footerText = [
  "Fixed the off-by-one in src/a.ts.",
  "",
  "Check the tests.",
  "agentId: agent_1 (use SendMessage with to: 'agent_1' to continue this agent)",
  "<usage>model: fake-b/model-b",
  "files_touched: src/a.ts, src/b.ts (+3 more)",
  "turn_cap: 12",
  "subagent_tokens: 900",
  "tool_uses: 4",
  "duration_ms: 65400</usage>",
].join("\n");

test("reads the parent-facing footer", () => {
  const s = parseAgentResultSummary(footerText);
  assert.ok(s);
  assert.equal(s.body, "Fixed the off-by-one in src/a.ts.\n\nCheck the tests.");
  assert.equal(s.model, "fake-b/model-b");
  assert.deepEqual(s.filesTouched, ["src/a.ts", "src/b.ts"]);
  assert.equal(s.moreFiles, 3);
  assert.equal(s.turnCap, 12);
  assert.equal(s.toolUses, 4);
  assert.equal(s.durationMs, 65400);
  assert.equal(s.tokens, 900);
  assert.equal(s.truncated, false);
});

test("files_touched: none is an empty list; truncation note is detected", () => {
  const s = parseAgentResultSummary(
    "HEAD\n\n[subagent result cut to the 1000-byte budget: full text in /x/result.md]\nagentId: a\n<usage>files_touched: none\ntool_uses: 0\nduration_ms: 5</usage>",
  );
  assert.deepEqual(s?.filesTouched, []);
  assert.equal(s?.truncated, true);
});

test("structured record and upstream output without Sando fields", () => {
  const s = parseAgentResultSummary({
    status: "completed",
    content: [{ type: "text", text: "ok" }],
    totalToolUseCount: 2,
    totalDurationMs: 10,
    model: "m/x",
    filesTouched: ["a"],
    resultTruncated: true,
  });
  assert.deepEqual(
    [s?.body, s?.model, s?.filesTouched, s?.toolUses, s?.truncated],
    ["ok", "m/x", ["a"], 2, true],
  );
  const upstream = parseAgentResultSummary(
    "done\nagentId: a\n<usage>tool_uses: 1\nduration_ms: 2</usage>",
  );
  assert.equal(upstream?.model, undefined);
  assert.equal(upstream?.filesTouched, undefined);
  assert.equal(upstream?.body, "done");
});

test("not a result: empty, background launch, plain text", () => {
  assert.equal(parseAgentResultSummary(""), null);
  assert.equal(parseAgentResultSummary(undefined), null);
  assert.equal(
    parseAgentResultSummary("Async agent launched successfully.\nagentId: a (internal ID)"),
    null,
  );
  assert.equal(parseAgentResultSummary("just some text"), null);
});

test("durations", () => {
  assert.equal(formatAgentDuration(450), "450 ms");
  assert.equal(formatAgentDuration(12_340), "12.3 s");
  assert.equal(formatAgentDuration(65_400), "1 min 5 s");
});
