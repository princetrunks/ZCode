// Sando: on-demand MCP tool loading (SANDO-MCP-ONDEMAND.md, SAN-4472 port 2). With SANDO_MCP_TOOLS=ondemand the
// provider request carries a load_tools catalog (names + <=160-character summaries) instead of every MCP schema.
// Run: pnpm test in apps/zcode-cli/packages/core (tsx --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLoadToolsDescription,
  createLoadToolsToolEntry,
  isDeferrableMcpToolName,
  mcpToolsModeFromEnv,
  noteMcpToolCalls,
  onDemandMcpState,
  projectOnDemandMcpTools,
  resolveLoadToolsRequest,
  summarizeToolDescription,
} from "../src/mcp/on-demand.ts";
import { isLeanTool } from "../src/context/prompt-profile.ts";

const P = "mcp__plugin_planner_planner__";
const names = ["add_note", "create_task", "list_tasks", "get_task"].map((n) => P + n);

test("SANDO_MCP_TOOLS: unset/all/eager = all, ondemand/on-demand = ondemand, anything else throws", () => {
  assert.equal(mcpToolsModeFromEnv({}), "all");
  assert.equal(mcpToolsModeFromEnv({ SANDO_MCP_TOOLS: "all" }), "all");
  assert.equal(mcpToolsModeFromEnv({ SANDO_MCP_TOOLS: "eager" }), "all");
  assert.equal(mcpToolsModeFromEnv({ SANDO_MCP_TOOLS: " OnDemand " }), "ondemand");
  assert.equal(mcpToolsModeFromEnv({ SANDO_MCP_TOOLS: "on-demand" }), "ondemand");
  assert.throws(
    () => mcpToolsModeFromEnv({ SANDO_MCP_TOOLS: "lazy" }),
    /SANDO_MCP_TOOLS expects all or ondemand/,
  );
});

test("deferrable: user MCP tools yes; built-ins, node_repl and computer use no", () => {
  assert.equal(isDeferrableMcpToolName(P + "add_note"), true);
  assert.equal(isDeferrableMcpToolName("Read"), false);
  assert.equal(isDeferrableMcpToolName("load_tools"), false);
  assert.equal(isDeferrableMcpToolName("mcp__node_repl__js"), false);
  assert.equal(isDeferrableMcpToolName("mcp__computer-use__click"), false);
});

test("summaries: first sentence, whitespace folded, never over 160 characters", () => {
  assert.equal(summarizeToolDescription("Add a note.\n\nLong details follow here."), "Add a note.");
  assert.equal(summarizeToolDescription(undefined), "");
  const long = "word ".repeat(100);
  const s = summarizeToolDescription(long);
  assert.ok(s.length <= 160, `length ${s.length}`);
  assert.ok(s.endsWith("…"));
  assert.ok(summarizeToolDescription("x".repeat(400)).length <= 160);
  assert.equal(summarizeToolDescription("v1.2 is the version. Next"), "v1.2 is the version.");
});

test("catalog: grouped by prefix, one line per tool, an example full name", () => {
  const d = buildLoadToolsDescription(
    names.map((name) => ({ name, description: `Does ${name}. Detail.` })),
  );
  assert.match(d, new RegExp(`Tools with the prefix ${P}\\n- add_note: Does ${P}add_note\\.`));
  assert.match(d, new RegExp(`e\\.g\\. \`${P}add_note\``));
  assert.equal(d.split("\n").filter((l) => l.startsWith("- ")).length, 4);
});

test("projection: unloaded deferred tools hidden, loaded shown, load_tools only while something is left", () => {
  const tools = [
    { name: "Read" },
    { name: "load_tools" },
    { name: "mcp__node_repl__js" },
    ...names.map((name) => ({ name })),
  ];
  const shown = (loaded) => projectOnDemandMcpTools(tools, new Set(loaded)).map((t) => t.name);
  assert.deepEqual(shown([]), ["Read", "load_tools", "mcp__node_repl__js"]);
  assert.deepEqual(shown([names[1]]), ["Read", "load_tools", "mcp__node_repl__js", names[1]]);
  assert.deepEqual(shown(names), ["Read", "mcp__node_repl__js", ...names]);
});

test("resolve: full names, unique short names, server wildcard, unknown with suggestions, already loaded", () => {
  const r = resolveLoadToolsRequest(
    [names[0], "create_task", "tasks", "nope_tool"],
    names,
    new Set(),
  );
  assert.deepEqual(r.loaded, [names[0], names[1]]);
  assert.deepEqual(
    r.unknown.map((u) => u.name),
    ["tasks", "nope_tool"],
  );
  assert.deepEqual(r.unknown[0].suggestions, [names[2]]);
  // Typos: "add_notes" and "creat_task" are near names.
  const typo = resolveLoadToolsRequest(["add_notes", "creat_task"], names, new Set());
  assert.deepEqual(
    typo.unknown.map((u) => u.suggestions),
    [[names[0]], [names[1]]],
  );
  const all = resolveLoadToolsRequest([`${P}*`], names, new Set([names[0]]));
  assert.deepEqual(all.loaded, names.slice(1));
  assert.deepEqual(all.alreadyLoaded, [names[0]]);
  // A bare "*" or a non-MCP prefix loads nothing.
  assert.equal(resolveLoadToolsRequest(["*"], names, new Set()).loaded.length, 0);
});

test("load_tools handler: loads into the session state and reports what it did", async () => {
  const state = onDemandMcpState({});
  const seen = [];
  const entry = createLoadToolsToolEntry({
    catalog: names.map((name) => ({ name, description: "x." })),
    state,
    onLoad: (r) => seen.push(r),
  });
  assert.equal(entry.metadata.name, "load_tools");
  assert.equal(entry.metadata.needsApproval, false);
  const out = await entry.handler({ names: ["add_note", "bogus"] }, {});
  assert.match(out, new RegExp(`Loaded 1 tool: ${P}add_note\\.`));
  assert.match(out, /No tool named bogus/);
  assert.deepEqual([...state.loaded], [names[0]]);
  assert.equal(seen.length, 1);
  // A string instead of an array (local models do this) still works.
  assert.match(await entry.handler({ names: `${names[2]}, ${names[3]}` }, {}), /Loaded 2 tools/);
  assert.match(await entry.handler({ names: [] }, {}), /No tool names given/);
});

test("a direct call to a listed tool loads it; unknown names and built-ins do not", () => {
  const state = onDemandMcpState({});
  noteMcpToolCalls(state, [names[2], "Read", P + "ghost"], new Set([names[2], "Read"]));
  assert.deepEqual([...state.loaded], [names[2]]);
});

test("the lean profile keeps load_tools", () => {
  assert.equal(isLeanTool("load_tools"), true);
});
