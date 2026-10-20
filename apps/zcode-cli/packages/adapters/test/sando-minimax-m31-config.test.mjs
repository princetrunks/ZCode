// MiniMax-M3.1-Flash through the real builtin rules (config/provider/zcode-builtin.json) and the option-map
// evaluator: levels low..max (no "disabled", which the API rejects), 131072 output cap, and the wire patch per API.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseZCodeBuiltinModelConfigRules } from "../../../../../packages/provider/src/index.ts";
import { compileModelOptionMaps } from "../../../../../packages/model-option-map/src/index.ts";

const builtin = JSON.parse(
  fs.readFileSync(new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
);
const rules = parseZCodeBuiltinModelConfigRules(builtin.config.modelConfigRules);
const resolve = (modelId, apiType, baseUrl) =>
  rules.resolve({ providerId: "builtin:minimax", templateId: "minimax", modelId, apiType, baseUrl }).toJSON();

test("M3.1 Flash on the Anthropic API: adaptive thinking + output_config.effort, cap 131072", () => {
  const c = resolve("MiniMax-M3.1-Flash", "anthropic-messages", "https://api.minimaxi.com/anthropic");
  assert.deepEqual(c.optionSpecs.reasoningLevel.values, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(c.optionSpecs.maxOutputTokens.max, 131072);
  assert.equal(c.properties.contextWindow, 1000000);
  const maps = compileModelOptionMaps(c.optionSpecs);
  assert.deepEqual(JSON.parse(JSON.stringify(maps.apply({}, { reasoningLevel: "xhigh", maxOutputTokens: 131072 }))), {
    thinking: { type: "adaptive" },
    output_config: { effort: "xhigh" },
    max_tokens: 131072,
  });
});

test("M3.1 Flash on the OpenAI API: reasoning_effort only (no thinking:disabled)", () => {
  const c = resolve("MiniMax-M3.1-Flash", "openai-chat-completions", "https://api.minimax.io/v1");
  const maps = compileModelOptionMaps(c.optionSpecs);
  const body = maps.apply({}, { reasoningLevel: "low", maxOutputTokens: 8000 });
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.thinking, undefined);
});

test("MiniMax-M3 (not 3.1) keeps upstream's rules", () => {
  const c = resolve("MiniMax-M3", "anthropic-messages", "https://api.minimaxi.com/anthropic");
  assert.deepEqual(c.optionSpecs.reasoningLevel.values, ["disabled", "enabled"]);
  assert.equal(c.optionSpecs.maxOutputTokens.max, 32000);
});
