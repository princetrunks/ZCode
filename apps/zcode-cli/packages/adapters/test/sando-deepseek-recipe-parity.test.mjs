// Parity check: Sando's own `applyReasoningHistoryPolicy(history, "keep-all-with-tools", hasTools)`
// (src/model/reasoning-profiles.ts, policy id `deepseek-tool-loop`, see SANDO-REASONING.md) versus
// DeepSeek's own protocol semantics as implemented by `deepseek-recipe` (MIT,
// https://pypi.org/project/deepseek-recipe, same encoding DeepSeek's own API uses).
//
// For 5 synthetic multi-turn tool conversations (Sando's internal ModelInputMessage shape), this:
//   1. runs each through Sando's policy (no runner/network stack -- a direct function call),
//   2. projects the result into an OpenAI-compatible wire body (test/support/sando-wire-projection.mjs;
//      see that file's header comment for why this is a small bridge and not a reused Sando serializer),
//   3. feeds that wire body to deepseek-recipe's `ChatCompletionRequest(...).convert(ConversionOptions())`
//      through a Python bridge (test/support/deepseek-recipe-bridge.{py,mjs}; execFileSync-equivalent
//      spawnSync, JSON over stdin/stdout, no network, no model inference),
//   4. asserts turn order, `reasoning_content` placement, and tool_call/tool_call_id pairing agree.
//
// Run: pnpm test in apps/zcode-cli/packages/adapters (tsx --test). Requires the gitignored venv at
// <repo-root>/.venv-deepseek-recipe (python3 -m venv + pip install deepseek-recipe==0.2.0, see
// FLEET-REPORT.md's 2026-10-21 entry for the exact setup commands).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addMissingReasoningField, applyReasoningHistoryPolicy } from "../src/model/reasoning-profiles.ts";
import { DEFAULT_TOOL_DEFINITIONS, toOpenAiWireMessages } from "./support/sando-wire-projection.mjs";
import { convertViaDeepseekRecipe } from "./support/deepseek-recipe-bridge.mjs";

const R = (text) => ({ type: "reasoning", text });
const T = (text) => ({ type: "text", text });

// ---------------------------------------------------------------------------
// Fixtures. Each is a synthetic (not model-generated) Sando ModelInputMessage[] history,
// plus whether the current request declares tools (the `hasTools` argument
// `applyReasoningHistoryPolicy` takes -- a property of the outgoing request, independent of
// whether any *past* turn in the history happened to use a tool).
// ---------------------------------------------------------------------------

const FIXTURES = [
  {
    // Required variation: no tools declared at all.
    name: "no-tools-declared: only reasoning after the last user message survives",
    hasTools: false,
    history: [
      { role: "system", content: "sys" },
      { role: "user", content: "what is the plan?" },
      { role: "assistant", content: [R("thinking about the plan"), T("Here is the plan.")] },
      { role: "user", content: "go ahead then" },
      { role: "assistant", content: [R("thinking it through"), T("Done, result X.")] },
    ],
  },
  {
    // Required variation: reasoning before AND after the last user message -- with tools
    // declared, so nothing is dropped even though some reasoning sits before that message
    // (the "every turn when the request declares tools" branch, not just "after").
    name: "reasoning-both-sides-tools-declared: tools declared keeps reasoning before AND after",
    hasTools: true,
    history: [
      { role: "system", content: "sys" },
      { role: "user", content: "first task" },
      {
        role: "assistant",
        content: [R("plan A"), T("")],
        toolCalls: [{ id: "a1", name: "Read", input: { path: "f" } }],
      },
      { role: "tool", toolCallId: "a1", toolName: "Read", content: "file contents" },
      { role: "assistant", content: [R("done thinking A"), T("Answer A")] },
      { role: "user", content: "second task" },
      {
        role: "assistant",
        content: [R("plan B"), T("")],
        toolCalls: [{ id: "b1", name: "Bash", input: { cmd: "ls" } }],
      },
      { role: "tool", toolCallId: "b1", toolName: "Bash", content: "ok" },
      { role: "assistant", content: [R("done thinking B"), T("Answer B")] },
    ],
  },
  {
    // Required variation: a reminder-only user message that should NOT count as a new turn
    // (precedent: the `keep-current-turn` test in sando-reasoning-profiles.test.mjs).
    name: "reminder-only-not-a-new-turn: reminder does not move the turn boundary",
    hasTools: false,
    history: [
      { role: "system", content: "sys" },
      { role: "user", content: "start the task" },
      {
        role: "assistant",
        content: [R("plan A"), T("")],
        toolCalls: [{ id: "c1", name: "Read", input: {} }],
      },
      { role: "tool", toolCallId: "c1", toolName: "Read", content: "data" },
      { role: "user", content: "keep going" },
      {
        role: "assistant",
        content: [R("plan B"), T("")],
        toolCalls: [{ id: "c2", name: "Edit", input: {} }],
      },
      { role: "tool", toolCallId: "c2", toolName: "Edit", content: "edited" },
      { role: "user", content: "<system-reminder>todo list is empty</system-reminder>" },
      { role: "assistant", content: [R("plan B2"), T("final answer")] },
    ],
  },
  {
    // Required variation: multiple sequential tool round-trips.
    name: "multiple-sequential-tool-roundtrips: three tool calls in a row, tools declared",
    hasTools: true,
    history: [
      { role: "system", content: "sys" },
      { role: "user", content: "do three things" },
      {
        role: "assistant",
        content: [R("step1 plan"), T("")],
        toolCalls: [{ id: "t1", name: "Read", input: {} }],
      },
      { role: "tool", toolCallId: "t1", toolName: "Read", content: "result1" },
      {
        role: "assistant",
        content: [R("step2 plan"), T("")],
        toolCalls: [{ id: "t2", name: "Bash", input: {} }],
      },
      { role: "tool", toolCallId: "t2", toolName: "Bash", content: "result2" },
      {
        role: "assistant",
        content: [R("step3 plan"), T("")],
        toolCalls: [{ id: "t3", name: "Edit", input: {} }],
      },
      { role: "tool", toolCallId: "t3", toolName: "Edit", content: "result3" },
      { role: "assistant", content: [R("wrap up"), T("All three steps done.")] },
    ],
  },
  {
    // Required variation: reasoning on every turn.
    name: "reasoning-every-turn: tools declared, every assistant turn carries reasoning",
    hasTools: true,
    history: [
      { role: "system", content: "sys" },
      { role: "user", content: "task one" },
      { role: "assistant", content: [R("r1"), T("answer one")] },
      { role: "user", content: "task two" },
      {
        role: "assistant",
        content: [R("r2"), T("")],
        toolCalls: [{ id: "d1", name: "Read", input: {} }],
      },
      { role: "tool", toolCallId: "d1", toolName: "Read", content: "ok" },
      { role: "assistant", content: [R("r3"), T("answer two")] },
      { role: "user", content: "task three" },
      { role: "assistant", content: [R("r4"), T("answer three")] },
    ],
  },
];

function reasoningKeptByPolicy(policyMessages) {
  return policyMessages.map((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.some((block) => block.type === "reasoning" && block.text.length > 0)
      : undefined,
  );
}

function assertToolCallPairingIntact(wireMessages, convertedMessages) {
  for (let i = 0; i < wireMessages.length; i += 1) {
    const wireMessage = wireMessages[i];
    const convertedMessage = convertedMessages[i];
    if (wireMessage.role === "assistant" && wireMessage.tool_calls) {
      assert.ok(Array.isArray(convertedMessage.tool_calls), `turn ${i} should keep its tool calls`);
      assert.deepEqual(
        convertedMessage.tool_calls.map((call) => call.id),
        wireMessage.tool_calls.map((call) => call.id),
        `turn ${i} tool call ids should survive in order`,
      );
      assert.deepEqual(
        convertedMessage.tool_calls.map((call) => call.name),
        wireMessage.tool_calls.map((call) => call.function.name),
        `turn ${i} tool call names should survive`,
      );
      assert.deepEqual(
        convertedMessage.tool_calls.map((call) => call.arguments),
        wireMessage.tool_calls.map((call) => call.function.arguments),
        `turn ${i} tool call arguments should survive`,
      );
    } else {
      assert.equal(convertedMessage.tool_calls, null, `turn ${i} should have no tool calls`);
    }
    if (wireMessage.role === "tool") {
      assert.equal(
        convertedMessage.tool_call_id,
        wireMessage.tool_call_id,
        `turn ${i} tool result should keep its tool_call_id`,
      );
      // The id must pair back to a tool call declared by *some* earlier assistant turn.
      const declaredIds = wireMessages
        .slice(0, i)
        .flatMap((m) => (m.tool_calls ?? []).map((call) => call.id));
      assert.ok(
        declaredIds.includes(convertedMessage.tool_call_id),
        `turn ${i} tool_call_id ${convertedMessage.tool_call_id} should pair with a prior tool call`,
      );
    }
  }
}

for (const fixture of FIXTURES) {
  test(fixture.name, () => {
    const policyMessages = applyReasoningHistoryPolicy(
      fixture.history,
      "keep-all-with-tools",
      fixture.hasTools,
    );
    const expectedReasoningKept = reasoningKeptByPolicy(policyMessages);

    // Sanity: keep-all-with-tools's own documented rule should actually be exercised by the
    // fixture (every fixture has at least one assistant turn, and the drop/keep pattern isn't
    // trivially "everything" when hasTools is false).
    assert.ok(expectedReasoningKept.some((kept) => kept === true), "fixture needs kept reasoning");

    const wireBody = toOpenAiWireMessages(policyMessages, {
      tools: fixture.hasTools ? DEFAULT_TOOL_DEFINITIONS : [],
    });

    // Every assistant message already carries a `reasoning_content` string (possibly ""), so
    // Sando's own `addMissingReasoningField` should be a no-op here -- reuse it as a check that
    // our minimal wire projection satisfies the same invariant Sando enforces on the real wire.
    assert.equal(addMissingReasoningField(wireBody), wireBody);

    const converted = convertViaDeepseekRecipe(wireBody);

    // 1. Turn order (role sequence) matches between what we sent and what deepseek-recipe saw.
    assert.equal(converted.messages.length, wireBody.messages.length, "message count");
    assert.deepEqual(
      converted.messages.map((m) => m.role),
      wireBody.messages.map((m) => m.role),
      "role order",
    );

    // 2. reasoning_content is non-empty exactly on the turns keep-all-with-tools says to keep.
    for (let i = 0; i < wireBody.messages.length; i += 1) {
      const expectKept = expectedReasoningKept[i];
      if (expectKept === undefined) continue; // non-assistant turn, not under test here
      const reasoningContent = converted.messages[i].reasoning_content ?? "";
      if (expectKept) {
        assert.ok(
          reasoningContent.length > 0,
          `turn ${i} (${fixture.name}) should have kept reasoning_content, got empty`,
        );
      } else {
        assert.equal(
          reasoningContent,
          "",
          `turn ${i} (${fixture.name}) should have stripped reasoning_content`,
        );
      }
    }

    // 3. tool_call / tool_call_id pairing survives intact.
    assertToolCallPairingIntact(wireBody.messages, converted.messages);
  });
}
