// Invisible-character smuggling filter at the provider-request boundary (Sando RD-2628, 2026-10-23).
//
// Every model request of the agent loop (main turn, `sando -p` headless, subagents, compaction, memory agent,
// verification) is projected by buildProviderRequestMessages; this is the one choke point where user prompts,
// pasted/attached files (prompt_attachment reminders), context files and tool results (Read, Bash, WebFetch,
// WebSearch, MCP, …) become provider messages. We scrub there, on the request-local copy, so canonical history
// and session persistence keep the original text (rewind/fork/UI unaffected) while the model never sees it.
//
// Assistant messages are left alone: they are the model's own output and replayed signed reasoning must stay
// byte-identical. Binary media (image/video/file dataUrl) is not text and is not touched.
import {
  hasInvisibleCandidates,
  modelMessageContentToText,
  scrubInvisible,
  scrubInvisibleNote,
  type InvisibleSmugglingLabel,
  type Logger,
  type ModelMessageContent,
  type ModelMessageContentBlock,
} from "@zcode/contracts";
import type { ModelInputMessage } from "../../agent/message-history.js";

export const INVISIBLE_SMUGGLING_LOG_MESSAGE = "[sando-invisible] smuggling characters removed";

export interface InvisibleScrubFinding {
  messageIndex: number;
  role: ModelInputMessage["role"];
  toolName?: string;
  toolCallId?: string;
  found: InvisibleSmugglingLabel[];
  removed: { tags: number; selectors: number };
  runs: number;
  /** Length of the scrubbed text (dedupes the warn line across re-projections; not the content itself). */
  scrubbedChars: number;
}

interface ContentScrub {
  content: ModelMessageContent;
  changed: boolean;
  tags: number;
  selectors: number;
  runs: number;
  found: Set<InvisibleSmugglingLabel>;
}

function scrubContent(content: ModelMessageContent): ContentScrub {
  const acc: ContentScrub = {
    content,
    changed: false,
    tags: 0,
    selectors: 0,
    runs: 0,
    found: new Set(),
  };
  const scrubText = (text: string): string => {
    if (!hasInvisibleCandidates(text)) return text;
    const result = scrubInvisible(text);
    acc.tags += result.removed.tags;
    acc.selectors += result.removed.selectors;
    acc.runs += result.runs;
    for (const label of result.found) acc.found.add(label);
    if (result.text !== text) acc.changed = true;
    return result.text;
  };
  if (typeof content === "string") {
    acc.content = scrubText(content);
    return acc;
  }
  const blocks = content.map((block): ModelMessageContentBlock => {
    if (block.type === "text") {
      const text = scrubText(block.text);
      return text === block.text ? block : { ...block, text };
    }
    if (block.type === "file" && typeof block.text === "string") {
      const text = scrubText(block.text);
      return text === block.text ? block : { ...block, text };
    }
    return block;
  });
  if (acc.changed) acc.content = blocks;
  return acc;
}

function isToolResultMessage(message: ModelInputMessage): boolean {
  return message.role === "tool" || Boolean(message.toolCallId || message.toolName);
}

function withLeadingNote(content: ModelMessageContent, note: string): ModelMessageContent {
  if (typeof content === "string") return content.length > 0 ? `${note}\n${content}` : note;
  return [{ type: "text", text: note }, ...content];
}

/**
 * Scrub a projected provider request. Returns a new array; only changed messages are new objects.
 * Messages that carry outside content (tool results by default, plus whatever `carriesOutsideContent` adds,
 * e.g. attached files) get a visible `[N hidden characters removed: …]` line when smuggling was found,
 * so the model knows something was taken out.
 */
export function scrubProviderRequestMessages(
  messages: readonly ModelInputMessage[],
  options: { carriesOutsideContent?: (messageIndex: number) => boolean } = {},
): {
  messages: ModelInputMessage[];
  findings: InvisibleScrubFinding[];
} {
  const findings: InvisibleScrubFinding[] = [];
  const next = messages.map((message, messageIndex) => {
    if (message.role === "assistant") return message;
    const scrub = scrubContent(message.content);
    if (!scrub.changed) return message;
    const found = [...scrub.found];
    const removed = { tags: scrub.tags, selectors: scrub.selectors };
    let content = scrub.content;
    if (found.length > 0) {
      findings.push({
        messageIndex,
        role: message.role,
        ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
        ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
        found,
        removed,
        runs: scrub.runs,
        scrubbedChars: modelMessageContentToText(content).length,
      });
      if (isToolResultMessage(message) || options.carriesOutsideContent?.(messageIndex) === true) {
        content = withLeadingNote(content, scrubInvisibleNote({ found, removed, smuggled: true }));
      }
    }
    return { ...message, content };
  });
  return { messages: next, findings };
}

// 每次请求都会重新投影整段历史；同一条被清洗的消息只记一次 warn，避免日志随轮次重复刷屏。
const LOGGED_FINDING_LIMIT = 512;
const loggedFindings = new Set<string>();

function findingKey(finding: InvisibleScrubFinding): string {
  return [
    finding.role,
    finding.toolCallId ?? "",
    finding.removed.tags,
    finding.removed.selectors,
    finding.runs,
    finding.scrubbedChars,
  ].join("|");
}

/** One structured warn line per new finding: counts and labels only, never the hidden content. */
export function logInvisibleScrubFindings(
  logger: Logger | undefined,
  findings: readonly InvisibleScrubFinding[],
): void {
  if (!logger || findings.length === 0) return;
  for (const finding of findings) {
    const key = findingKey(finding);
    if (loggedFindings.has(key)) continue;
    if (loggedFindings.size >= LOGGED_FINDING_LIMIT) loggedFindings.clear();
    loggedFindings.add(key);
    logger.warn(INVISIBLE_SMUGGLING_LOG_MESSAGE, {
      role: finding.role,
      ...(finding.toolName !== undefined ? { toolName: finding.toolName } : {}),
      ...(finding.toolCallId !== undefined ? { toolCallId: finding.toolCallId } : {}),
      labels: finding.found,
      removedTags: finding.removed.tags,
      removedSelectors: finding.removed.selectors,
      selectorRuns: finding.runs,
    });
  }
}
