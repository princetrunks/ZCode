// Minimal projection of Sando's internal ModelInputMessage history (the shape
// `applyReasoningHistoryPolicy` consumes, see src/model/reasoning-profiles.ts) into the
// OpenAI-compatible wire shape DeepSeek's own API/encoding expects: role, content
// (string, or null when an assistant turn is tool-calls-only), `reasoning_content` on
// every assistant message (per SANDO-REASONING.md: "every assistant message carries
// reasoning_content, empty when the turn had none"), `tool_calls` / `tool_call_id`.
//
// Sando's own `toAiSdkMessages` (src/model/transform.ts) targets the Vercel AI SDK's
// `ModelMessage` shape, not raw wire JSON -- the final OpenAI-compatible JSON body is
// built from that by @ai-sdk/openai-compatible (a third-party dependency), so there is
// no Sando-owned function that goes straight from ModelInputMessage to wire JSON for us
// to import. The one directly-reusable piece of Sando's own wire-shape logic is
// `addMissingReasoningField` (reasoning-profiles.ts), which operates on exactly this
// wire shape and documents the "empty string when absent" rule; this module computes
// reasoning_content directly (every assistant message gets one, same rule) and uses
// `addMissingReasoningField` as a belt-and-suspenders idempotency check in the test file.

const textOf = (content) => {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text" || block.type === "reasoning")
    .map((block) => block.text)
    .join("");
};

const reasoningOf = (content) => {
  if (typeof content === "string") return "";
  return content
    .filter((block) => block.type === "reasoning")
    .map((block) => block.text)
    .join("");
};

/**
 * @param {import("@zcode/contracts").ModelInputMessage[]} messages
 * @param {{ tools?: unknown[] }} [requestOptions]
 */
export function toOpenAiWireMessages(messages, requestOptions = {}) {
  const wire = messages.map((message) => {
    switch (message.role) {
      case "system":
        return { role: "system", content: textOf(message.content) };
      case "user":
        return { role: "user", content: textOf(message.content) };
      case "assistant": {
        const text = textOf(message.content);
        const reasoning = reasoningOf(message.content);
        const toolCalls = (message.toolCalls ?? []).map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        }));
        return {
          role: "assistant",
          // OpenAI chat-completions wants `content: null` (not "") for a pure tool-call
          // turn with no text; deepseek-recipe's own Message.content is always a string
          // on the read side, but the *request* body it accepts mirrors the OpenAI
          // convention here (see test_bindings.py's tool-call fixture: content: None).
          content: toolCalls.length > 0 && text.length === 0 ? null : text,
          reasoning_content: reasoning,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        };
      }
      case "tool":
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: textOf(message.content),
        };
      default:
        throw new Error(`unhandled role: ${message.role}`);
    }
  });

  return {
    model: "DeepSeek-V4.1-Flash",
    thinking: { type: "enabled" },
    ...(requestOptions.tools && requestOptions.tools.length > 0
      ? { tools: requestOptions.tools }
      : {}),
    messages: wire,
  };
}

export const DEFAULT_TOOL_DEFINITIONS = [
  { type: "function", function: { name: "Read", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "Bash", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "Edit", parameters: { type: "object", properties: {} } } },
];
