// Sando reasoning profiles: which model gets which history policy, and what each policy does to a
// request history. Run: pnpm test in apps/zcode-cli/packages/adapters (tsx --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMissingReasoningField,
  applyReasoningHistoryPolicy,
  requiresReasoningField,
  resolveReasoningProfile,
} from "../src/model/reasoning-profiles.ts";

const noEnv = {};

test("every current forge model id resolves to passthrough", () => {
  for (const id of [
    "qwen3.8-27b",
    "bonsai2-27b",
    "torii-1.5-9b",
    "qwen38-9b",
    "torii-big-35b",
    "qwythos",
    "gemma-4-27b",
    "lily",
    "gemma3-12b",
    "torii-coder-125b",
    "glm-5.1",
    "kimi-k3",
    "claude-opus-5-5",
  ]) {
    assert.equal(resolveReasoningProfile(id, noEnv).history, "passthrough", id);
  }
});

test("MiniMax M2..M3.1 keep all thinking; DeepSeek keeps all when tools are declared", () => {
  for (const id of [
    "MiniMax-M3.1-Flash",
    "MiniMax-M3",
    "MiniMax-M2.7-highspeed",
    "MiniMax-M2",
    "minimax/minimax-m3",
    "minimax-m3.1-flash",
  ]) {
    const p = resolveReasoningProfile(id, noEnv);
    assert.equal(p.id, "minimax-interleaved", id);
    assert.equal(p.history, "keep-all", id);
  }
  for (const id of [
    "deepseek-v4.1-flash",
    "deepseek-v4.1-flash-1017",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek/deepseek-v4.1-flash",
    "deepseek-flash",
    "deepseek-reasoner",
    "deepseek-chat",
  ]) {
    const p = resolveReasoningProfile(id, noEnv);
    assert.equal(p.id, "deepseek-tool-loop", id);
    assert.equal(p.history, "keep-all-with-tools", id);
  }
  assert.equal(resolveReasoningProfile("minimax-text-01", noEnv).history, "passthrough");
});

test("SANDO_REASONING_HISTORY forces a policy; unknown values are ignored", () => {
  assert.equal(
    resolveReasoningProfile("bonsai2-27b", { SANDO_REASONING_HISTORY: "strip" }).history,
    "strip",
  );
  assert.equal(
    resolveReasoningProfile("MiniMax-M3.1-Flash", { SANDO_REASONING_HISTORY: "nonsense" }).history,
    "keep-all",
  );
});

const R = (text) => ({ type: "reasoning", text });
const T = (text) => ({ type: "text", text });
const history = () => [
  { role: "system", content: "sys" },
  { role: "user", content: "first task" },
  {
    role: "assistant",
    content: [R("plan A"), T("")],
    toolCalls: [{ id: "a", name: "Read", input: {} }],
  },
  { role: "tool", toolCallId: "a", toolName: "Read", content: "file" },
  { role: "assistant", content: [R("done thinking A"), T("answer A")] },
  { role: "user", content: "second task" },
  {
    role: "assistant",
    content: [R("plan B")],
    toolCalls: [{ id: "b", name: "Bash", input: {} }],
  },
  { role: "tool", toolCallId: "b", toolName: "Bash", content: "ok" },
  { role: "user", content: "<system-reminder>todo list is empty</system-reminder>" },
  {
    role: "assistant",
    content: [R("plan B2"), T("still working")],
    toolCalls: [{ id: "c", name: "Edit", input: {} }],
  },
  { role: "tool", toolCallId: "c", toolName: "Edit", content: "edited" },
];
const reasoningOf = (msgs) =>
  msgs.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((b) => b.type === "reasoning").map((b) => b.text) : [],
  );

test("passthrough and keep-all return the very same array", () => {
  const h = history();
  assert.equal(applyReasoningHistoryPolicy(h, "passthrough"), h);
  assert.equal(applyReasoningHistoryPolicy(h, "keep-all"), h);
});

test("keep-current-turn drops reasoning before the last real user message, not after a reminder", () => {
  const h = history();
  const out = applyReasoningHistoryPolicy(h, "keep-current-turn");
  assert.deepEqual(reasoningOf(out), ["plan B", "plan B2"]);
  assert.equal(out.length, h.length);
  // tool calls and text survive; the input is not mutated
  assert.deepEqual(out[2].toolCalls, h[2].toolCalls);
  assert.deepEqual(out[4].content, [T("answer A")]);
  assert.deepEqual(reasoningOf(h), ["plan A", "done thinking A", "plan B", "plan B2"]);
});

test("strip drops all reasoning and keeps an empty assistant turn as a placeholder", () => {
  const h = [
    { role: "user", content: "q" },
    { role: "assistant", content: [R("only thoughts")] },
    { role: "user", content: "q2" },
  ];
  const out = applyReasoningHistoryPolicy(h, "strip");
  assert.deepEqual(out[1].content, [T("(no content)")]);
  assert.deepEqual(reasoningOf(applyReasoningHistoryPolicy(history(), "strip")), []);
});

test("no reasoning in history: every policy returns the same array", () => {
  const h = [
    { role: "user", content: "q" },
    { role: "assistant", content: [T("a")] },
  ];
  for (const p of ["keep-current-turn", "strip"]) assert.equal(applyReasoningHistoryPolicy(h, p), h);
});

test("keep-all-with-tools: unchanged with tools, current turn only without (DeepSeek encoder drop_thinking)", () => {
  const h = history();
  assert.equal(applyReasoningHistoryPolicy(h, "keep-all-with-tools", true), h);
  assert.deepEqual(reasoningOf(applyReasoningHistoryPolicy(h, "keep-all-with-tools", false)), [
    "plan B",
    "plan B2",
  ]);
});

test("empty reasoning_content is required only for DeepSeek models on deepseek.com", () => {
  assert.equal(requiresReasoningField("deepseek-v4-flash", "https://api.deepseek.com/v1"), true);
  assert.equal(requiresReasoningField("deepseek-v4-flash", "https://openrouter.ai/api/v1"), false);
  assert.equal(requiresReasoningField("deepseek-v4-flash", "http://127.0.0.1:8100/v1"), false);
  assert.equal(requiresReasoningField("bonsai2-27b", "https://api.deepseek.com/v1"), false);
  const body = {
    model: "deepseek-v4-flash",
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", reasoning_content: "r" },
      { role: "assistant", content: null, tool_calls: [] },
    ],
  };
  const out = addMissingReasoningField(body);
  assert.deepEqual(
    out.messages.map((m) => m.reasoning_content),
    [undefined, "r", ""],
  );
  assert.equal(addMissingReasoningField(out), out);
});
