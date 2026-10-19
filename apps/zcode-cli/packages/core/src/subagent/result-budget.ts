// ============================================================
// Sando: small-context discipline for subagent results (SANDO-SUBAGENTS.md)
// ============================================================
// Forge models run 16k–64k windows, so a child's final message is cut to a byte budget before it
// reaches the parent. The head is kept (children are told to lead with the answer); the full text goes
// to a file the parent can Read when it really needs more. Only the final message is ever returned —
// never the child's transcript.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_SUBAGENT_RESULT_MAX_BYTES = 6_000;
/** Below this a budget would leave no room for an answer next to the truncation note. */
const MIN_SUBAGENT_RESULT_MAX_BYTES = 512;
export const SUBAGENT_FILES_TOUCHED_LIMIT = 20;

export function resolveSubagentResultMaxBytes(value: number | string | undefined): number {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= MIN_SUBAGENT_RESULT_MAX_BYTES
    ? n
    : DEFAULT_SUBAGENT_RESULT_MAX_BYTES;
}

export interface BudgetedSubagentResult {
  text: string;
  truncated: boolean;
  /** Present only when truncated: the full text was written here. */
  resultFile?: string;
}

/** Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, never splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  let end = Math.max(0, maxBytes);
  // Step back over UTF-8 continuation bytes (10xxxxxx) so the cut lands on a code point boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

export async function budgetSubagentResult(
  text: string,
  options: { maxBytes: number; resultFile: string },
): Promise<BudgetedSubagentResult> {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= options.maxBytes) return { text, truncated: false };

  let written = true;
  try {
    await mkdir(dirname(options.resultFile), { recursive: true });
    await writeFile(options.resultFile, text, "utf8");
  } catch {
    written = false;
  }
  const where = written
    ? `full text (${totalBytes} bytes) in ${options.resultFile} — Read it only if you need more`
    : `${totalBytes} bytes in total; the full text could not be saved`;
  const note = `\n\n[subagent result cut to the ${options.maxBytes}-byte budget: ${where}]`;
  const head = truncateUtf8(text, options.maxBytes - Buffer.byteLength(note, "utf8"));
  return {
    text: `${head.trimEnd()}${note}`,
    truncated: true,
    ...(written ? { resultFile: options.resultFile } : {}),
  };
}

/** Footer line for the parent: at most SUBAGENT_FILES_TOUCHED_LIMIT paths, then "+N more". */
export function formatFilesTouched(files: readonly string[]): string {
  if (files.length === 0) return "none";
  const shown = files.slice(0, SUBAGENT_FILES_TOUCHED_LIMIT).join(", ");
  const rest = files.length - SUBAGENT_FILES_TOUCHED_LIMIT;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}
