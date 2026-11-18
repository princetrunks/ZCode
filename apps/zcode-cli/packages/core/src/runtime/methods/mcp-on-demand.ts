// Sando SANDO_MCP_TOOLS=ondemand at the provider request boundary (SANDO-MCP-ONDEMAND.md).
import {
  mcpToolsModeFromEnv,
  noteMcpToolCalls,
  onDemandMcpState,
  projectOnDemandMcpTools,
} from "../../mcp/on-demand.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** Hides deferred MCP tools the model has not loaded yet; a no-op with SANDO_MCP_TOOLS=all (the default is ondemand). */
export function projectProviderMcpTools<T extends { name: string }>(
  runtime: Pick<AgentRuntimeInternal, "registry">,
  tools: T[],
): T[] {
  if (mcpToolsModeFromEnv(process.env) !== "ondemand") return tools;
  if (!runtime.registry.get("load_tools")) return tools;
  return projectOnDemandMcpTools(tools, onDemandMcpState(runtime).loaded);
}

/** A direct call to a listed MCP tool loads it: the call runs now, its schema is sent from the next request on. */
export function noteOnDemandMcpToolCalls(
  runtime: Pick<AgentRuntimeInternal, "registry">,
  names: readonly string[],
): void {
  if (mcpToolsModeFromEnv(process.env) !== "ondemand") return;
  if (!runtime.registry.get("load_tools")) return;
  const known = new Set(names.filter((name) => runtime.registry.get(name) !== undefined));
  noteMcpToolCalls(onDemandMcpState(runtime), names, known);
}
