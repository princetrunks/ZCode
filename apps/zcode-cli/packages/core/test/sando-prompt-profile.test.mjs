// Sando prompt profiles (SANDO-LEAN-PROMPT.md): who gets the lean profile, what the lean tool surface and
// system prompt contain, and that the default build path is untouched.
// Run: pnpm test in apps/zcode-cli/packages/core (tsx --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLeanSystemSection,
  parsePromptProfileSetting,
  projectLeanTools,
  resolveEffectivePromptProfile,
} from "../src/context/prompt-profile.ts";
import { createContextBuilder } from "../src/context/builder.ts";

const local = { localEndpoint: true };
const cloud = { localEndpoint: false };

test("SANDO_PROMPT_PROFILE parsing: unset -> undefined, known values pass, anything else throws", () => {
  assert.equal(parsePromptProfileSetting(undefined), undefined);
  assert.equal(parsePromptProfileSetting("  "), undefined);
  assert.equal(parsePromptProfileSetting("lean"), "lean");
  assert.equal(parsePromptProfileSetting(" Lean-Local "), "lean-local");
  assert.equal(parsePromptProfileSetting("default"), "default");
  assert.throws(() => parsePromptProfileSetting("tiny"), /expects one of default, lean, lean-local/);
});

test("resolver: default unless opted in; lean-local only for local endpoints; never for child or custom prompts", () => {
  assert.equal(resolveEffectivePromptProfile({ model: local }), "default");
  assert.equal(resolveEffectivePromptProfile({ setting: "default", model: local }), "default");
  assert.equal(resolveEffectivePromptProfile({ setting: "lean", model: cloud }), "lean");
  assert.equal(resolveEffectivePromptProfile({ setting: "lean", model: undefined }), "lean");
  assert.equal(resolveEffectivePromptProfile({ setting: "lean-local", model: local }), "lean");
  assert.equal(resolveEffectivePromptProfile({ setting: "lean-local", model: cloud }), "default");
  assert.equal(resolveEffectivePromptProfile({ setting: "lean-local", model: {} }), "default");
  assert.equal(resolveEffectivePromptProfile({ setting: "lean-local", model: undefined }), "default");
  for (const taskType of ["interactive", "fork"]) {
    assert.equal(resolveEffectivePromptProfile({ setting: "lean", taskType }), "lean", taskType);
  }
  for (const taskType of ["subagent_child", "workflow_child", "workflow_parent", "nested_workflow_child", "selection_side_chat"]) {
    assert.equal(resolveEffectivePromptProfile({ setting: "lean", model: local, taskType }), "default", taskType);
  }
  assert.equal(resolveEffectivePromptProfile({ setting: "lean", hasCustomSystemPrompt: true }), "default");
});

const schema = (props) => ({ type: "object", properties: props, required: Object.keys(props).slice(0, 1) });
const fullTools = [
  "Agent", "AskUserQuestion", "Bash", "Edit", "EnterPlanMode", "Read", "Skill", "TodoRead", "TodoWrite", "WebFetch",
  "Write", "CreateWorkflow", "SaveWorkflow", "ListModels", "mcp__planner__get_task",
].map((name) => ({
  name,
  description: `long ${name} description `.repeat(50),
  inputSchema:
    name === "Bash"
      ? schema({ command: { type: "string", description: "cmd" }, description: { type: "string", description: "x".repeat(900) } })
      : schema({ file_path: { type: "string", description: "path" } }),
}));

test("lean tools: core coding tools + MCP tools kept, short descriptions, schemas keep their shape", () => {
  const lean = projectLeanTools(fullTools);
  assert.deepEqual(
    lean.map((t) => t.name),
    ["Bash", "Edit", "Read", "TodoWrite", "Write", "mcp__planner__get_task"],
  );
  for (const tool of lean.filter((t) => !t.name.startsWith("mcp__"))) {
    assert.ok(tool.description.length < 260, `${tool.name}: ${tool.description.length}`);
  }
  const mcp = lean.find((t) => t.name.startsWith("mcp__"));
  assert.equal(mcp.description, fullTools.at(-1).description, "user-configured MCP tools are not rewritten");
  const bash = lean.find((t) => t.name === "Bash");
  assert.deepEqual(Object.keys(bash.inputSchema.properties), ["command", "description"]);
  assert.deepEqual(bash.inputSchema.required, ["command"]);
  assert.ok(bash.inputSchema.properties.description.description.length < 80);
  assert.equal(fullTools.find((t) => t.name === "Bash").inputSchema.properties.description.description.length, 900, "input not mutated");
});

test("lean system prompt: one line per present tool, no lines for absent ones", () => {
  const all = buildLeanSystemSection(["Read", "Write", "Edit", "Bash", "TodoWrite", "Grep", "Glob"]).content;
  assert.match(all, /^You are Sando/);
  assert.match(all, /Inspect files with Read/);
  assert.match(all, /Search with Grep for contents, Glob for file names/);
  assert.match(all, /TodoWrite/);
  const bashOnly = buildLeanSystemSection(["Bash"]).content;
  assert.doesNotMatch(bashOnly, /Read,|Edit|TodoWrite|Grep/);
  assert.match(bashOnly, /`rg`/);
  assert.match(bashOnly, /exit code/);
  assert.ok(all.length < 2600, `lean prompt is ${all.length} chars`);
});

const envInfo = {
  cwd: "/w",
  platform: "linux",
  shell: "zsh",
  osVersion: "linux",
  nodeVersion: "v24",
  isGitRepository: true,
  gitBranch: "main",
  gitStatus: "clean",
};
const model = { providerId: "forge", modelId: "m", localEndpoint: true };
const builderConfig = (extra) => ({
  workingDirectory: "/w",
  envInfo,
  model,
  currentDate: "2026-10-20",
  userInstructions: undefined,
  guidanceToolNames: ["Read", "Write", "Edit", "Bash", "TodoWrite"],
  ...extra,
});

test("ContextBuilder: lean replaces the default prompt sections; default stays as it was", () => {
  const def = createContextBuilder(builderConfig({})).build();
  const explicitDefault = createContextBuilder(builderConfig({ promptProfile: "default" })).build();
  assert.deepEqual(explicitDefault.systemMessages, def.systemMessages);
  assert.ok(def.sections.some((s) => s.source === "identity"));
  assert.ok(def.sections.some((s) => s.source === "context_management"));

  const lean = createContextBuilder(builderConfig({ promptProfile: "lean" })).build();
  assert.deepEqual(
    lean.sections.map((s) => s.source),
    ["lean_system_prompt", "env_info", "current_date"],
  );
  const system = lean.systemMessages.map((m) => m.content).join("\n");
  assert.match(system, /^You are Sando/);
  assert.match(system, /Working directory: \/w/);
  assert.match(system, /Git: branch main, clean/);
  assert.match(system, /Model: forge\/m/);
  assert.doesNotMatch(system, /ZCode|# Memory|mermaid|```form/);
  assert.ok(lean.totalChars < def.totalChars / 3, `${lean.totalChars} vs ${def.totalChars}`);
});

test("ContextBuilder: a custom system prompt wins over lean", () => {
  const custom = createContextBuilder(builderConfig({ promptProfile: "lean", customSystemPrompt: "Be a pirate." })).build();
  assert.ok(custom.sections.some((s) => s.source === "custom_system_prompt"));
  assert.ok(!custom.sections.some((s) => s.source === "lean_system_prompt"));
});
