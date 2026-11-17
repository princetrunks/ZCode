import { compactHeadroomModeFromEnv } from "../deps.js";
import type { AutoCompactPolicyConfig, Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";

/** Auto compact and microcompact share one policy config so their thresholds cannot drift apart. */
export function buildAutoCompactPolicyConfig(
  runtime: AgentRuntimeInternal,
  model: Model,
): AutoCompactPolicyConfig {
  return {
    contextWindow: model.properties.contextWindow,
    // Sando: per-model headroom (SANDO-COMPACT-HEADROOM.md); SANDO_COMPACT_HEADROOM=upstream restores upstream.
    headroomMode: compactHeadroomModeFromEnv(),
    modelHeadroomTokens: model.properties.compactHeadroomTokens,
    ...runtime.config.compact,
    maxOutputTokens: resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    }),
    modelContextBudgetStrategy: runtime.config.modelContextBudgetStrategy,
  };
}
