import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY as DEFAULT_BUDGET_STRATEGY } from "@zcode/shared";
import type { CompactModelMessage } from "./manual.js";
import { estimateMessageTokens, hasEnoughMessagesToCompact } from "./manual.js";
import type { LocalMicrocompactPolicyConfig } from "./microcompact.js";

export const DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000;
// 正常请求默认输出已收敛到 32K，auto compact 必须预留同一目标；
// 否则请求预算和压缩窗口会继续按两套常量计算。
export const DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 100;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

// Sando: per-model compaction headroom (SANDO-COMPACT-HEADROOM.md). Upstream compacts at W - min(O, 21K) - 13K,
// a buffer tuned for 200K windows: on a 32K local model with 8K output that is 11.6K tokens, ~35% of the window.
// Sando compacts at min(W x 0.85, W - O - H) with H from the model config or a default by window size, and the
// output reserve capped at W / 4. SANDO_COMPACT_HEADROOM=upstream restores the upstream formula.
// Idea from DeepSeek Harness (MIT); no code copied.
export const COMPACT_HEADROOM_ENV = "SANDO_COMPACT_HEADROOM";
export const SANDO_AUTOCOMPACT_WINDOW_RATIO = 0.85;
export const SANDO_AUTOCOMPACT_OUTPUT_RESERVE_WINDOW_FRACTION = 0.25;
export type CompactHeadroomMode = "sando" | "upstream";

/** Default headroom H by context window: 16K -> 2K, 32K -> 3K, 64K -> 6K, 128K+ -> upstream 13K. */
export function defaultCompactHeadroomTokens(contextWindow: number): number {
  if (contextWindow <= 24_576) return 2_000;
  if (contextWindow <= 49_152) return 3_000;
  if (contextWindow <= 98_304) return 6_000;
  return AUTOCOMPACT_BUFFER_TOKENS;
}

/** SANDO_COMPACT_HEADROOM: unset/auto/on = per-model headroom, upstream/off = upstream formula; anything else throws. */
export function compactHeadroomModeFromEnv(env: NodeJS.ProcessEnv = process.env): CompactHeadroomMode {
  const raw = (env[COMPACT_HEADROOM_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "auto" || raw === "on") return "sando";
  if (raw === "upstream" || raw === "off") return "upstream";
  throw new Error(`${COMPACT_HEADROOM_ENV} expects auto or upstream, got "${raw}"`);
}

export interface AutoCompactPolicyConfig {
  enabled?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Sando: "upstream" = W - min(O, 21K) - bufferTokens (13K); default "sando". */
  headroomMode?: CompactHeadroomMode;
  /** Sando: per-model headroom H (model properties.compactHeadroomTokens); bufferTokens still wins when set. */
  modelHeadroomTokens?: number;
  modelContextBudgetStrategy?: "legacy" | "preflight-v1";
  summaryReserveTokens?: number;
  bufferTokens?: number;
  thresholdPercentOverride?: number;
  maxConsecutiveFailures?: number;
  microcompact?: LocalMicrocompactPolicyConfig;
}

export type AutoCompactTokenSource = "estimate" | "provider_usage";

export interface AutoCompactTokenOverride {
  baseTokenCount?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsageTokenCount?: number;
  incrementalTokenCount?: number;
  outputTokens?: number;
  source: Extract<AutoCompactTokenSource, "provider_usage">;
  tokenCount: number;
}

export interface AutoCompactDecision {
  shouldCompact: boolean;
  tokenCount: number;
  tokenSource: AutoCompactTokenSource;
  estimatedTokenCount: number;
  providerCacheReadTokens?: number;
  providerCacheWriteTokens?: number;
  providerBaseTokenCount?: number;
  providerContextUsageTokenCount?: number;
  providerIncrementalTokenCount?: number;
  providerOutputTokens?: number;
  threshold: number;
  contextWindow: number;
  effectiveContextWindow: number;
  maxOutputTokens?: number;
  modelContextBudgetStrategy: "legacy" | "preflight-v1";
  outputReserveTokens: number;
  headroomMode: CompactHeadroomMode;
  headroomTokens: number;
  thresholdPercent: number;
  reason:
    | "disabled"
    | "not_enough_messages"
    | "circuit_breaker"
    | "below_threshold"
    | "above_threshold";
}

export function getEffectiveContextWindowSize(config: AutoCompactPolicyConfig = {}): number {
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  // provider 的 context window 是 input + output 共享窗口；自动压缩只能让出输入侧，
  // 因此阈值分母必须先扣掉当前模型允许的 output token，而不是继续吃完整 contextWindow。
  const reserve = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  return Math.max(0, contextWindow - reserve);
}

export function getAutoCompactOutputReserveTokens(config: AutoCompactPolicyConfig = {}): number {
  const maxOutputTokens = positiveInt(config.maxOutputTokens);
  // 旧 legacy 分支为完整模型输出预留窗口，既过早压缩又要求远端选择；现在统一保留至多 21K。
  const reserve = Math.min(
    maxOutputTokens ?? DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
    PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
  );
  if (resolveHeadroomMode(config) === "upstream") return reserve;
  // Sando: a model that declares no output limit gets 32K -> 21K reserved; on a 32K window that alone is 64%.
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  return Math.min(
    reserve,
    Math.floor(contextWindow * SANDO_AUTOCOMPACT_OUTPUT_RESERVE_WINDOW_FRACTION),
  );
}

export function getAutoCompactHeadroomTokens(config: AutoCompactPolicyConfig = {}): number {
  const explicit = positiveInt(config.bufferTokens);
  if (explicit !== undefined) return explicit;
  if (resolveHeadroomMode(config) === "upstream") return AUTOCOMPACT_BUFFER_TOKENS;
  return (
    positiveInt(config.modelHeadroomTokens) ??
    defaultCompactHeadroomTokens(positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW)
  );
}

export function getAutoCompactThreshold(config: AutoCompactPolicyConfig = {}): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const headroom = getAutoCompactHeadroomTokens(config);
  const threshold = Math.max(0, effectiveContextWindow - headroom);
  if (resolveHeadroomMode(config) === "upstream") return threshold;
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  return Math.min(threshold, Math.floor(contextWindow * SANDO_AUTOCOMPACT_WINDOW_RATIO));
}

function resolveHeadroomMode(config: AutoCompactPolicyConfig): CompactHeadroomMode {
  return config.headroomMode ?? "sando";
}

export function shouldAutoCompact(input: {
  messages: readonly CompactModelMessage[];
  config?: AutoCompactPolicyConfig;
  consecutiveFailures?: number;
  tokenOverride?: AutoCompactTokenOverride;
}): AutoCompactDecision {
  const config = input.config ?? {};
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const outputReserveTokens = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  const threshold = getAutoCompactThreshold(config);
  const thresholdPercent = DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT;
  const estimatedTokenCount = estimateMessageTokens(input.messages);
  const tokenCount = input.tokenOverride?.tokenCount ?? estimatedTokenCount;
  const tokenSource = input.tokenOverride?.source ?? "estimate";
  const common = {
    contextWindow,
    effectiveContextWindow,
    estimatedTokenCount,
    providerCacheReadTokens: input.tokenOverride?.cacheReadTokens,
    providerCacheWriteTokens: input.tokenOverride?.cacheWriteTokens,
    maxOutputTokens: positiveInt(config.maxOutputTokens),
    modelContextBudgetStrategy: DEFAULT_BUDGET_STRATEGY,
    outputReserveTokens,
    headroomMode: resolveHeadroomMode(config),
    headroomTokens: getAutoCompactHeadroomTokens(config),
    providerBaseTokenCount: input.tokenOverride?.baseTokenCount,
    providerContextUsageTokenCount: input.tokenOverride?.contextUsageTokenCount,
    providerIncrementalTokenCount: input.tokenOverride?.incrementalTokenCount,
    providerOutputTokens: input.tokenOverride?.outputTokens,
    threshold,
    thresholdPercent,
    tokenCount,
    tokenSource,
  } satisfies Omit<AutoCompactDecision, "reason" | "shouldCompact">;

  if (config.enabled === false) {
    return { ...common, shouldCompact: false, reason: "disabled" };
  }

  if (!hasEnoughMessagesToCompact(input.messages)) {
    return {
      ...common,
      shouldCompact: false,
      reason: "not_enough_messages",
    };
  }

  const maxFailures =
    positiveInt(config.maxConsecutiveFailures) ?? MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
  if ((input.consecutiveFailures ?? 0) >= maxFailures) {
    return {
      ...common,
      shouldCompact: false,
      reason: "circuit_breaker",
    };
  }

  if (tokenCount < threshold) {
    return {
      ...common,
      shouldCompact: false,
      reason: "below_threshold",
    };
  }

  return { ...common, shouldCompact: true, reason: "above_threshold" };
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
