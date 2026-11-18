// Sando: on-demand MCP tool loading (SANDO-MCP-ONDEMAND.md, SAN-4472 port 2; idea from dsh, MIT, no code copied).
//
// With SANDO_MCP_TOOLS=ondemand the provider request carries no MCP tool schemas up front. Instead one `load_tools`
// tool lists every MCP tool by name with a summary of at most 160 characters, grouped by server. The model loads the
// tools it needs; from the next request on they are in the tool list with their full schemas, for the rest of the
// session. Calling a listed tool directly also loads it (the call runs; the schema follows on the next request).
// The bundled node_repl / computer-use servers are never deferred: they are runtime features, not catalog tools.

import type { ModelToolContract } from "@zcode/contracts";
import type { ToolEntry } from "../tool/types.js";

export const LOAD_TOOLS_TOOL_NAME = "load_tools";
export const MCP_SUMMARY_MAX_CHARS = 160;

export type McpToolsMode = "all" | "ondemand";

export function mcpToolsModeFromEnv(env: NodeJS.ProcessEnv = process.env): McpToolsMode {
  const value = env.SANDO_MCP_TOOLS?.trim().toLowerCase();
  if (!value || value === "all" || value === "eager") return "all";
  if (value === "ondemand" || value === "on-demand") return "ondemand";
  throw new Error(`SANDO_MCP_TOOLS expects all or ondemand, got "${env.SANDO_MCP_TOOLS}"`);
}

const NEVER_DEFERRED_MCP_PREFIXES = [
  "mcp__node_repl__",
  "mcp__computer_use__",
  "mcp__computer-use__",
] as const;

export function isDeferrableMcpToolName(name: string): boolean {
  return (
    name.startsWith("mcp__") &&
    !NEVER_DEFERRED_MCP_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** First sentence (or line) of a description, cut to `max` characters on a word boundary. */
export function summarizeToolDescription(
  description: string | undefined,
  max = MCP_SUMMARY_MAX_CHARS,
): string {
  const flat = (description ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const sentenceEnd = flat.search(/[.!?](\s|$)/);
  const first = sentenceEnd >= 0 ? flat.slice(0, sentenceEnd + 1) : flat;
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

export interface CatalogTool {
  name: string;
  description?: string;
  serverName?: string;
  toolName?: string;
}

function splitMcpName(tool: CatalogTool): { server: string; short: string } {
  if (tool.serverName && tool.toolName) return { server: tool.serverName, short: tool.toolName };
  const rest = tool.name.slice("mcp__".length);
  const at = rest.indexOf("__");
  return at < 0
    ? { server: "", short: rest }
    : { server: rest.slice(0, at), short: rest.slice(at + 2) };
}

/** The `load_tools` description: how to use it, then one line per tool, grouped by server (full name = prefix + name). */
export function buildLoadToolsDescription(tools: readonly CatalogTool[]): string {
  const groups = new Map<string, { prefix: string; lines: string[] }>();
  for (const tool of tools) {
    const { short } = splitMcpName(tool);
    const prefix = tool.name.slice(0, tool.name.length - short.length);
    const group = groups.get(prefix) ?? { prefix, lines: [] };
    const summary = summarizeToolDescription(tool.description);
    group.lines.push(summary ? `- ${short}: ${summary}` : `- ${short}`);
    groups.set(prefix, group);
  }
  const sections = [...groups.values()].map(
    (group) => `Tools with the prefix ${group.prefix}\n${group.lines.join("\n")}`,
  );
  const example = tools[0]?.name ?? "mcp__server__tool";
  return [
    "Load MCP tools by name before you use them. The tools below exist but their parameters are not in your tool list yet.",
    `Pass full names (prefix + name, e.g. \`${example}\`) or \`<prefix>*\` for a whole server. Loaded tools stay available for the rest of the session; call them on your next step.`,
    "",
    ...sections,
  ].join("\n");
}

export interface OnDemandMcpState {
  readonly loaded: Set<string>;
}

const states = new WeakMap<object, OnDemandMcpState>();

export function onDemandMcpState(owner: object): OnDemandMcpState {
  let state = states.get(owner);
  if (!state) {
    state = { loaded: new Set() };
    states.set(owner, state);
  }
  return state;
}

/** Drops deferred MCP tools that are not loaded yet. `load_tools` stays only while something is left to load. */
export function projectOnDemandMcpTools<T extends Pick<ModelToolContract, "name">>(
  tools: readonly T[],
  loaded: ReadonlySet<string>,
): T[] {
  const deferredLeft = tools.some(
    (tool) => isDeferrableMcpToolName(tool.name) && !loaded.has(tool.name),
  );
  return tools.filter((tool) => {
    if (tool.name === LOAD_TOOLS_TOOL_NAME) return deferredLeft;
    return !isDeferrableMcpToolName(tool.name) || loaded.has(tool.name);
  });
}

/** Records MCP tools the model called directly, so their schemas are sent from the next request on. */
export function noteMcpToolCalls(
  state: OnDemandMcpState,
  names: readonly string[],
  known: ReadonlySet<string>,
): void {
  for (const name of names)
    if (isDeferrableMcpToolName(name) && known.has(name)) state.loaded.add(name);
}

export interface LoadToolsResolution {
  loaded: string[];
  alreadyLoaded: string[];
  unknown: { name: string; suggestions: string[] }[];
}

export function resolveLoadToolsRequest(
  requested: readonly string[],
  available: readonly string[],
  loaded: ReadonlySet<string>,
): LoadToolsResolution {
  const result: LoadToolsResolution = { loaded: [], alreadyLoaded: [], unknown: [] };
  const seen = new Set<string>();
  const add = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    (loaded.has(name) ? result.alreadyLoaded : result.loaded).push(name);
  };
  for (const raw of requested) {
    const name = raw.trim();
    if (!name) continue;
    if (name.endsWith("*")) {
      const prefix = name.slice(0, -1);
      const matches = available.filter(
        (tool) => tool.startsWith(prefix) && prefix.startsWith("mcp__"),
      );
      if (matches.length > 0) {
        matches.forEach(add);
        continue;
      }
    } else if (available.includes(name)) {
      add(name);
      continue;
    } else {
      // A bare short name ("add_note") is accepted when it names exactly one tool.
      const bySuffix = available.filter((tool) => tool.endsWith(`__${name}`));
      if (bySuffix.length === 1) {
        add(bySuffix[0]!);
        continue;
      }
    }
    const needle = (name.split("__").pop() ?? name).replace(/\*$/, "").toLowerCase();
    const suggestions = available.filter((tool) => isNearName(needle, shortName(tool))).slice(0, 5);
    result.unknown.push({ name, suggestions });
  }
  return result;
}

function shortName(tool: string): string {
  return (tool.split("__").pop() ?? tool).toLowerCase();
}

/** Typo-tolerant match for suggestions: one name contains the other, or they are at most 2 edits apart. */
function isNearName(needle: string, short: string): boolean {
  if (needle.length < 3) return false;
  if (short.includes(needle) || needle.includes(short)) return true;
  if (Math.abs(short.length - needle.length) > 2) return false;
  let previous = Array.from({ length: short.length + 1 }, (_, j) => j);
  for (let i = 1; i <= needle.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= short.length; j += 1) {
      const cost = needle[i - 1] === short[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[short.length]! <= 2;
}

export function formatLoadToolsResult(resolution: LoadToolsResolution): string {
  const lines: string[] = [];
  if (resolution.loaded.length > 0) {
    lines.push(
      `Loaded ${resolution.loaded.length} tool${resolution.loaded.length === 1 ? "" : "s"}: ${resolution.loaded.join(", ")}.`,
      "Their full parameters are in your tool list from your next step on: call them directly.",
    );
  }
  if (resolution.alreadyLoaded.length > 0) {
    lines.push(`Already loaded: ${resolution.alreadyLoaded.join(", ")}.`);
  }
  for (const unknown of resolution.unknown) {
    lines.push(
      unknown.suggestions.length > 0
        ? `No tool named ${unknown.name}. Did you mean: ${unknown.suggestions.join(", ")}?`
        : `No tool named ${unknown.name}. Use the exact names from the load_tools description.`,
    );
  }
  if (lines.length === 0)
    lines.push(
      "No tool names given. Pass `names`: the full names from the load_tools description.",
    );
  return lines.join("\n");
}

const LOAD_TOOLS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    names: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description:
        "Full tool names from this tool's description, or `<prefix>*` for every tool of one server.",
    },
  },
  required: ["names"],
  additionalProperties: false,
} as const;

const LOAD_TOOLS_OUTPUT_SCHEMA = { type: "string" } as const;

export function createLoadToolsToolEntry(options: {
  catalog: readonly CatalogTool[];
  state: OnDemandMcpState;
  onLoad?: (resolution: LoadToolsResolution) => void;
}): ToolEntry {
  const available = options.catalog.map((tool) => tool.name);
  const description = buildLoadToolsDescription(options.catalog);
  return {
    capability: "Make deferred MCP tools available to the model; no external effect",
    metadata: {
      name: LOAD_TOOLS_TOOL_NAME,
      description,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: 5_000,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    inputSchema: LOAD_TOOLS_INPUT_SCHEMA,
    outputSchema: LOAD_TOOLS_OUTPUT_SCHEMA,
    permission: {
      permission: "load_tools",
      reason: "load_tools only changes which tool schemas the model is shown",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: 16_384,
      maxModelBytes: 16_384,
      strategy: "truncate",
      preview: { maxBytes: 16_384, direction: "head" },
    },
    timeout: { defaultMs: 5_000, maxMs: 5_000, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "none",
      userVisibleMessage: "load_tools was cancelled",
    },
    trace: {
      required: true,
      propagateToAdapters: false,
      recordInput: "summary",
      recordOutput: "summary",
    },
    handler: async (input) => {
      const raw = (input as { names?: unknown }).names;
      const names = Array.isArray(raw)
        ? raw.filter((name): name is string => typeof name === "string")
        : typeof raw === "string"
          ? raw.split(/[\s,]+/)
          : [];
      const resolution = resolveLoadToolsRequest(names, available, options.state.loaded);
      for (const name of resolution.loaded) options.state.loaded.add(name);
      options.onLoad?.(resolution);
      return formatLoadToolsResult(resolution);
    },
    formatModelContent: (output) => String(output),
  };
}
