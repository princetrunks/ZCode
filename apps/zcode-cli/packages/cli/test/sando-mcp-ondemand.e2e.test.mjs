// Sando on-demand MCP tools, end to end (SANDO-MCP-ONDEMAND.md, SAN-4472 port 2): the built CLI (dist/zcode.cjs)
// headless in yolo mode, a scripted OpenAI-compatible server and a scripted stdio MCP server (fake-mcp-server.mjs)
// loaded as a plugin with 40 Planner-sized tools. No GPU, no network.
// Run: pnpm -r --filter "@zcode/cli..." run build && node --test test/sando-mcp-ondemand.e2e.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const CLI = new URL("../dist/zcode.cjs", import.meta.url).pathname;
const MCP_STUB = new URL("./fake-mcp-server.mjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-mcp-ondemand-e2e-"));
const home = path.join(base, "home");
const ws = path.join(base, "ws");
const plugin = path.join(base, "plugin");
const callsLog = path.join(base, "calls.jsonl");
const PREFIX = "mcp__plugin_fakeplanner_planner__";
let fake;

// 40 tools shaped like the Planner's: a few sentences of description and 4-6 described parameters each.
const TOOLS = Array.from({ length: 40 }, (_, i) => ({
  name: i === 0 ? "add_note" : i === 1 ? "get_task" : `planner_tool_${i}`,
  description:
    `Planner operation ${i}: does one specific thing to projects, tasks or notes. ` +
    "It returns the updated record as JSON. Use it when the user asks for this exact operation; prefer list tools for browsing. " +
    "Fields that are not given keep their current values.",
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(
      ["task_id", "project_id", "title", "body", "status", "due_date"]
        .slice(0, 4 + (i % 3))
        .map((key) => [
          key,
          {
            type: key.endsWith("_id") ? "integer" : "string",
            description: `The ${key.replace("_", " ")} for operation ${i}.`,
          },
        ]),
    ),
    required: ["task_id"],
  },
}));

function writeHome() {
  for (const dir of [
    ws,
    path.join(home, ".zcode", "v2"),
    path.join(home, ".zcode", "cli"),
    path.join(plugin, ".zcode-plugin"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(base, "tools.json"),
    JSON.stringify({ tools: TOOLS, responses: { get_task: { id: 4481, title: "E_TASK_TITLE" } } }),
  );
  fs.writeFileSync(
    path.join(plugin, ".zcode-plugin", "plugin.json"),
    JSON.stringify({ name: "fakeplanner", version: "0.0.1", description: "e2e" }),
  );
  fs.writeFileSync(
    path.join(plugin, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        planner: {
          type: "stdio",
          command: process.execPath,
          args: [MCP_STUB, path.join(base, "tools.json"), callsLog],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(home, ".zcode", "cli", "config.json"),
    JSON.stringify({ permission: { mode: "yolo" }, plugins: { enabled: true, dirs: [plugin] } }),
  );
  fs.writeFileSync(
    path.join(home, ".zcode", "v2", "provider_config.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerOrder: ["fake-a"],
        providerConfigRules: {
          providerRules: [
            {
              providerId: "fake-a",
              enabled: true,
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "fake" },
                api: {
                  type: "openai-chat-completions",
                  baseUrl: `http://127.0.0.1:${fake.port}/v1`,
                },
                personalModelIds: ["model-a"],
                modelOrder: ["model-a"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [],
          manualProviderModelRules: [
            {
              providerId: "fake-a",
              modelId: "model-a",
              config: {
                enabled: true,
                properties: {
                  contextWindow: 131072,
                  supportsJsonSchemaOutput: false,
                  supportsNativeWebSearch: false,
                  supportsMidConversationSystem: false,
                  inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
                },
                optionSpecs: {
                  reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
                  maxOutputTokens: { max: 8192 },
                },
              },
            },
          ],
        },
        defaultModelSelection: { providerId: "fake-a", modelId: "model-a" },
      },
    }),
  );
}

before(async () => {
  fake = await startFakeOpenAI();
  writeHome();
});

after(async () => {
  await fake?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

/** steps: the scripted model's tool calls, one per request, in order. Async: the fake server lives in this process. */
async function sando(steps, env = {}) {
  fake.state.requests.length = 0;
  fs.rmSync(callsLog, { force: true });
  // handler, not scenario: a real model can call a tool it only knows from the catalog (scenario drops those calls).
  fake.state.handler = ({ msgs }) => {
    const step = steps[msgs.filter((m) => m.role === "tool").length];
    return step ? { calls: [step] } : {};
  };
  const childEnv = { ...process.env, HOME: home, SANDO_PROMPT_PROFILE: "default", ...env };
  for (const k of [
    "ZCODE_MODEL",
    "ZCODE_HARNESS_DIR",
    "ZCODE_MAX_TURNS",
    "ZCODE_CONFINE_TO_CWD",
    "SANDO_MCP_TOOLS",
  ]) {
    if (!(k in env)) delete childEnv[k];
  }
  const child = spawn(
    process.execPath,
    [CLI, "-p", "use the planner", "--mode", "yolo", "--json"],
    {
      cwd: ws,
      env: childEnv,
      timeout: 120_000,
    },
  );
  let stderr = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (c) => (stderr += c));
  const status = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
  fake.state.handler = null;
  const calls = fs.existsSync(callsLog)
    ? fs
        .readFileSync(callsLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  return { status, stderr, requests: [...fake.state.requests], calls };
}

const pluginTools = (req) => req.tools.filter((name) => name.startsWith(PREFIX));
const def = (req, name) => req.toolDefs.find((t) => t.function?.name === name);
const toolTexts = (req) =>
  req.rawMessages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

test("default (unset) is ondemand in every profile: the catalog, no MCP schemas up front", async () => {
  for (const profile of ["default", "lean", "lean-local"]) {
    const r = await sando([], { SANDO_PROMPT_PROFILE: profile });
    assert.equal(r.status, 0, `${profile}: ${r.stderr}`);
    assert.deepEqual(pluginTools(r.requests[0]), [], profile);
    assert.ok(r.requests[0].tools.includes("load_tools"), profile);
  }
});

test("SANDO_MCP_TOOLS=all is the off switch in every profile: every MCP tool is sent, there is no load_tools", async () => {
  for (const profile of ["default", "lean", "lean-local"]) {
    for (const value of ["all", "eager"]) {
      const r = await sando([], { SANDO_MCP_TOOLS: value, SANDO_PROMPT_PROFILE: profile });
      assert.equal(r.status, 0, `${profile}/${value}: ${r.stderr}`);
      assert.equal(pluginTools(r.requests[0]).length, 40, `${profile}/${value}`);
      assert.ok(!r.requests[0].tools.includes("load_tools"), `${profile}/${value}`);
    }
  }
});

test("ondemand: the first request has the catalog instead of the schemas, >= 80% fewer MCP bytes", async () => {
  const all = await sando([], { SANDO_MCP_TOOLS: "all" });
  const od = await sando([], { SANDO_MCP_TOOLS: "ondemand" });
  assert.equal(od.status, 0, od.stderr);
  assert.deepEqual(pluginTools(od.requests[0]), []);
  const catalog = def(od.requests[0], "load_tools");
  assert.ok(catalog, "load_tools is offered");
  const lines = catalog.function.description.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 40);
  for (const line of lines) assert.ok(line.length <= 2 + 30 + 2 + 160, line);
  assert.match(
    catalog.function.description,
    new RegExp(`Tools with the prefix ${PREFIX}\\n- add_note: Planner operation 0`),
  );
  const allBytes = JSON.stringify(
    all.requests[0].toolDefs.filter((t) => t.function.name.startsWith(PREFIX)),
  ).length;
  const odBytes = JSON.stringify(catalog).length;
  assert.ok(odBytes <= allBytes * 0.2, `catalog ${odBytes} B vs schemas ${allBytes} B`);
  // The built-ins are untouched.
  assert.deepEqual(
    od.requests[0].tools.filter((n) => n !== "load_tools"),
    all.requests[0].tools.filter((n) => !n.startsWith(PREFIX)),
  );
});

test("ondemand: load_tools by short name, then the tool is in the list with its schema and the call works", async () => {
  const r = await sando(
    [
      { name: "load_tools", args: { names: ["get_task"] } },
      { name: `${PREFIX}get_task`, args: { task_id: 4481 } },
    ],
    { SANDO_MCP_TOOLS: "ondemand" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.requests.length, 3);
  assert.deepEqual(pluginTools(r.requests[0]), []);
  assert.deepEqual(pluginTools(r.requests[1]), [`${PREFIX}get_task`]);
  assert.deepEqual(
    Object.keys(def(r.requests[1], `${PREFIX}get_task`).function.parameters.properties),
    ["task_id", "project_id", "title", "body", "status"],
  );
  assert.ok(r.requests[1].tools.includes("load_tools"), "39 tools are still left to load");
  const results = toolTexts(r.requests[2]);
  assert.match(results[0], new RegExp(`Loaded 1 tool: ${PREFIX}get_task`));
  assert.match(results[1], /E_TASK_TITLE/);
  assert.deepEqual(r.calls, [{ name: "get_task", args: { task_id: 4481 } }]);
});

test("ondemand: a direct call without load_tools runs, and the schema is sent from the next request on", async () => {
  const r = await sando([{ name: `${PREFIX}add_note`, args: { task_id: 1, body: "hi" } }], {
    SANDO_MCP_TOOLS: "ondemand",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [{ name: "add_note", args: { task_id: 1, body: "hi" } }]);
  assert.deepEqual(pluginTools(r.requests[1]), [`${PREFIX}add_note`]);
});

test("ondemand: unknown names get suggestions; a server wildcard loads all 40 and retires load_tools", async () => {
  const r = await sando(
    [
      { name: "load_tools", args: { names: ["add_notes", "planner_tool_7"] } },
      { name: "load_tools", args: { names: [`${PREFIX}*`] } },
    ],
    { SANDO_MCP_TOOLS: "ondemand" },
  );
  assert.equal(r.status, 0, r.stderr);
  const results = toolTexts(r.requests[2]);
  assert.match(results[0], /Loaded 1 tool: .*planner_tool_7/);
  assert.match(
    results[0],
    new RegExp(`No tool named add_notes\\. Did you mean: ${PREFIX}add_note`),
  );
  assert.match(results[1], /Loaded 39 tools/);
  assert.equal(pluginTools(r.requests[2]).length, 40);
  assert.ok(!r.requests[2].tools.includes("load_tools"));
});

test("ondemand + lean profile: load_tools survives the lean tool filter", async () => {
  const r = await sando([], { SANDO_MCP_TOOLS: "ondemand", SANDO_PROMPT_PROFILE: "lean" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.requests[0].tools.includes("load_tools"));
  assert.deepEqual(pluginTools(r.requests[0]), []);
});

test("SANDO_MCP_TOOLS with an unknown value fails at startup, before any model request", async () => {
  const r = await sando([], { SANDO_MCP_TOOLS: "lazy" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SANDO_MCP_TOOLS expects all or ondemand/);
  assert.equal(r.requests.length, 0);
});
