// ============================================================
// Sando: tool-result pruner (head + tail instead of clearing)
// ============================================================
// When microcompact's pressure trigger fires, old tool results longer than `thresholdChars` keep their first
// `headChars` and last `tailChars` with a marker in between, instead of being replaced by
// "[Old tool result content cleared]". Build/test logs put the error at the end, so the tail is the part the model
// would otherwise re-run the tool for. No model call; a pruned result is shorter than the threshold, so a second pass
// leaves it alone. Microcompact's clearing stays as the fallback when it is enabled and pruning was not enough.
// Off switch: SANDO_TOOL_RESULT_PRUNER=off (upstream behaviour: nothing runs unless microcompact is enabled).
// Idea from DeepSeek Harness compaction-tool-result-pruner (MIT); no code copied.
import type { ModelMessageContent } from "@zcode/contracts";

export const TOOL_RESULT_PRUNER_ENV = "SANDO_TOOL_RESULT_PRUNER";
export const DEFAULT_TOOL_RESULT_PRUNE_THRESHOLD_CHARS = 8_192;
export const DEFAULT_TOOL_RESULT_PRUNE_HEAD_CHARS = 4_096;
export const DEFAULT_TOOL_RESULT_PRUNE_TAIL_CHARS = 1_024;
// 预请求阶段最新一组工具结果模型还没看过，倒数第二组只看过一次；这两组不裁剪。
export const DEFAULT_TOOL_RESULT_PRUNE_KEEP_RECENT = 2;

export interface ToolResultPrunerConfig {
  enabled?: boolean;
  thresholdChars?: number;
  headChars?: number;
  tailChars?: number;
  /** Newest tool-result groups (one per assistant tool-call message) that are never pruned. */
  keepRecentToolResults?: number;
}

export interface ResolvedToolResultPrunerConfig {
  thresholdChars: number;
  headChars: number;
  tailChars: number;
  keepRecentToolResults: number;
}

const OFF_VALUES = new Set(["off", "0", "false", "no"]);
const ON_VALUES = new Set(["", "on", "1", "true", "yes"]);

/** SANDO_TOOL_RESULT_PRUNER: unset/on = enabled, off = disabled; anything else throws (no silent fallback). */
export function toolResultPrunerEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[TOOL_RESULT_PRUNER_ENV] ?? "").trim().toLowerCase();
  if (OFF_VALUES.has(raw)) return false;
  if (ON_VALUES.has(raw)) return true;
  throw new Error(`${TOOL_RESULT_PRUNER_ENV} expects on or off, got "${raw}"`);
}

export function resolveToolResultPrunerConfig(
  config: ToolResultPrunerConfig | undefined,
): ResolvedToolResultPrunerConfig | undefined {
  if (config?.enabled !== true) return undefined;
  const thresholdChars =
    nonNegativeInt(config.thresholdChars) ?? DEFAULT_TOOL_RESULT_PRUNE_THRESHOLD_CHARS;
  const headChars = nonNegativeInt(config.headChars) ?? DEFAULT_TOOL_RESULT_PRUNE_HEAD_CHARS;
  const tailChars = nonNegativeInt(config.tailChars) ?? DEFAULT_TOOL_RESULT_PRUNE_TAIL_CHARS;
  // 裁剪后必须严格变短且低于阈值，否则同一结果会在每次压力触发时被反复处理。
  if (headChars + tailChars + formatPruneMarker(thresholdChars).length >= thresholdChars) {
    throw new Error(
      `tool-result pruner: headChars + tailChars + marker must be below thresholdChars (${thresholdChars})`,
    );
  }
  return {
    thresholdChars,
    headChars,
    tailChars,
    keepRecentToolResults: Math.max(
      1,
      nonNegativeInt(config.keepRecentToolResults) ?? DEFAULT_TOOL_RESULT_PRUNE_KEEP_RECENT,
    ),
  };
}

export function formatPruneMarker(omittedChars: number): string {
  return `\n… ${omittedChars} chars pruned from this old tool result (run the tool again or Read the file for them) …\n`;
}

/**
 * Head + tail of a tool result's text, or undefined when it is within the threshold or holds media.
 * Non-text blocks are never pruned; text blocks keep their order and only the middle span is removed.
 */
export function pruneToolResultContent(
  content: ModelMessageContent,
  config: ResolvedToolResultPrunerConfig,
): ModelMessageContent | undefined {
  if (typeof content === "string") {
    if (content.length <= config.thresholdChars) return undefined;
    return pruneText(content, config);
  }
  if (content.some((block) => block.type !== "text")) return undefined;
  const texts = content.map((block) => (block.type === "text" ? block.text : ""));
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  if (total <= config.thresholdChars) return undefined;

  const removedStart = safeBoundary(texts.join(""), config.headChars);
  const removedEnd = safeBoundary(texts.join(""), total - config.tailChars);
  const marker = formatPruneMarker(removedEnd - removedStart);
  const pruned: ModelMessageContent = [];
  let offset = 0;
  let markerInserted = false;
  content.forEach((block, index) => {
    const text = texts[index]!;
    const start = offset;
    const end = start + text.length;
    offset = end;
    const keepHead = text.slice(0, clamp(removedStart - start, 0, text.length));
    const keepTail = text.slice(clamp(removedEnd - start, 0, text.length));
    const intersects = start < removedEnd && end > removedStart;
    const insert = intersects && !markerInserted ? marker : "";
    if (insert) markerInserted = true;
    const next = intersects ? keepHead + insert + keepTail : text;
    if (next.length > 0) pruned.push({ ...block, text: next } as (typeof content)[number]);
  });
  return pruned;
}

function pruneText(text: string, config: ResolvedToolResultPrunerConfig): string {
  const removedStart = safeBoundary(text, config.headChars);
  const removedEnd = safeBoundary(text, text.length - config.tailChars);
  return (
    text.slice(0, removedStart) +
    formatPruneMarker(removedEnd - removedStart) +
    text.slice(removedEnd)
  );
}

/** Move a cut point off the middle of a UTF-16 surrogate pair. */
function safeBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff && index > 0 ? index - 1 : index;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nonNegativeInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
