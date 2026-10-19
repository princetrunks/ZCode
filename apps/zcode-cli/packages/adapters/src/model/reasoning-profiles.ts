import type { ModelInputMessage } from "@zcode/contracts";

/**
 * Sando: per-model reasoning profiles (how a model's own thinking is replayed in later requests).
 *
 * Core keeps every assistant reasoning block for the whole session (also after a resume), and the
 * request serializers send it all back: `reasoning_content` on the OpenAI-compatible path,
 * `thinking` blocks (signed) on the Anthropic path. That is "keep-all". Reasoning models differ:
 * - MiniMax M2/M3/M3.1 want every turn's thinking back (interleaved thinking), unchanged.
 * - DeepSeek V3.2/V4 want it back inside the current tool-call loop only; older turns are ignored.
 * Effort and output caps live in the provider config rules (config/provider/zcode-builtin.json);
 * this table is the history half and documents the rest. Spec + sources: SANDO-REASONING.md.
 *
 * `passthrough` = exactly what Sando sent before profiles existed. Every model that no profile
 * matches (all current forge models) gets it, so their requests are byte-identical to before.
 */
export type ReasoningHistoryPolicy = "passthrough" | "keep-all" | "keep-current-turn" | "strip";

export const REASONING_HISTORY_POLICIES: readonly ReasoningHistoryPolicy[] = [
  "passthrough",
  "keep-all",
  "keep-current-turn",
  "strip",
];

export interface ReasoningProfile {
  readonly id: string;
  /** Matched against the model id (case-insensitive), e.g. `MiniMax-M3.1-Flash`, `deepseek/deepseek-v4-flash`. */
  readonly modelMatch: RegExp;
  readonly history: ReasoningHistoryPolicy;
  /** Recommended output cap; enforced through the config rules, recorded here for the report and /model help. */
  readonly recommendedMaxOutputTokens?: number;
  /** Effort values the model accepts on the wire (informational; the config rule maps Sando's levels). */
  readonly effortValues?: readonly string[];
  readonly source: string;
}

export const PASSTHROUGH_PROFILE: ReasoningProfile = Object.freeze({
  id: "passthrough",
  modelMatch: /^$/,
  history: "passthrough",
  source: "Sando default: unchanged request history",
});

export const BUILTIN_REASONING_PROFILES: readonly ReasoningProfile[] = Object.freeze([
  {
    id: "minimax-interleaved",
    // MiniMax-M2, M2.1, M2.5, M2.7, M3, M3.1-Flash, with or without a vendor prefix (minimax/minimax-m3).
    modelMatch: /(?:^|[/:])minimax-m[23](?:[.\-:/[].*)?$/i,
    history: "keep-all",
    recommendedMaxOutputTokens: 131072,
    effortValues: ["low", "medium", "high", "xhigh", "max"],
    source:
      "platform.minimax.io text-m3-function-call + text-openai-api (reasoning_content must be preserved completely); " +
      "MiniMax-M2 model card (do not remove <think>); M3 chat_template renders reasoning for every assistant turn",
  },
  {
    id: "deepseek-tool-loop",
    // deepseek-v4-flash, deepseek-v4-pro, deepseek-v4.1-flash(-1017), deepseek-flash, deepseek-reasoner, deepseek-chat.
    modelMatch: /(?:^|[/:])deepseek-(?:v[34](?:[.-].*)?|flash|reasoner|chat)$/i,
    history: "keep-current-turn",
    recommendedMaxOutputTokens: 262144,
    effortValues: ["low", "high", "max"],
    source:
      "api-docs.deepseek.com thinking mode (reasoning_content is sent back within the tool-call loop and dropped for " +
      "earlier turns); deepseek-ai/deepseek-harness does the same (see SANDO-REASONING.md for file:line)",
  },
] satisfies ReasoningProfile[]);

/**
 * `SANDO_REASONING_HISTORY` forces one policy for every model (A/B runs, debugging). Unset, unknown or
 * empty values fall back to the table, so a typo never changes behaviour silently in an unexpected way.
 */
export function resolveReasoningProfile(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): ReasoningProfile {
  const forced = env.SANDO_REASONING_HISTORY?.trim();
  if (forced && (REASONING_HISTORY_POLICIES as readonly string[]).includes(forced)) {
    return { ...PASSTHROUGH_PROFILE, id: `env:${forced}`, history: forced as ReasoningHistoryPolicy };
  }
  return BUILTIN_REASONING_PROFILES.find((p) => p.modelMatch.test(modelId)) ?? PASSTHROUGH_PROFILE;
}

const EMPTY_ASSISTANT_FALLBACK = "(no content)";

/**
 * Apply a history policy. Returns the same array when nothing changes (passthrough, keep-all, or no
 * reasoning to drop), so callers can keep their identity checks.
 */
export function applyReasoningHistoryPolicy(
  messages: ModelInputMessage[],
  policy: ReasoningHistoryPolicy,
): ModelInputMessage[] {
  if (policy === "passthrough" || policy === "keep-all") return messages;
  const keepFrom = policy === "keep-current-turn" ? currentTurnStart(messages) : messages.length;

  let result: ModelInputMessage[] | undefined;
  for (let index = 0; index < keepFrom; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    if (!message.content.some((block) => block.type === "reasoning")) continue;

    let content = message.content.filter((block) => block.type !== "reasoning");
    // A reasoning-only assistant message without tool calls would become empty; keep the turn
    // boundary (user/assistant alternation) with the same placeholder upstream uses.
    if (content.length === 0 && (message.toolCalls?.length ?? 0) === 0) {
      content = [{ type: "text", text: EMPTY_ASSISTANT_FALLBACK }];
    }
    result ??= messages.slice();
    result[index] = { ...message, content };
  }
  return result ?? messages;
}

/**
 * Index of the last real user message. Tool results are not a new turn, and neither is a user message
 * that only carries `<system-reminder>` blocks: models without mid-conversation system support (every
 * forge llama.cpp model) get reminders as user messages in the middle of a tool loop.
 */
function currentTurnStart(messages: ModelInputMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || message.toolCallId || message.toolName) continue;
    if (isReminderOnly(message)) continue;
    return index;
  }
  return 0;
}

const REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function isReminderOnly(message: ModelInputMessage): boolean {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.every((block) => block.type === "text")
        ? message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
        : undefined;
  if (text === undefined || !text.includes("<system-reminder>")) return false;
  return text.replace(REMINDER_BLOCK, "").trim().length === 0;
}
