// Sando native subagents (SANDO-SUBAGENTS.md): read the Agent tool's returned text into a card summary.
// The row's output text is the parent-facing result: the child's final message, then
// `agentId: …` and a `<usage>…</usage>` footer (model, files_touched, turn_cap, tool_uses, duration_ms).
// A structured AgentCompletedOutput record is read directly. Pure, no React.

export interface AgentResultSummary {
  /** The child's final message, without the footer. */
  body: string;
  model?: string;
  filesTouched?: string[];
  /** "+N more" beyond the listed files. */
  moreFiles?: number;
  turnCap?: number;
  toolUses?: number;
  durationMs?: number;
  tokens?: number;
  truncated: boolean;
}

const TRUNCATION_MARK = "[subagent result cut to the ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInt(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function fromRecord(record: Record<string, unknown>): AgentResultSummary | null {
  if (record.status !== "completed" || !Array.isArray(record.content)) return null;
  const body = record.content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n")
    .trim();
  const files = Array.isArray(record.filesTouched)
    ? record.filesTouched.filter((f): f is string => typeof f === "string")
    : undefined;
  return {
    body,
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(files ? { filesTouched: files } : {}),
    ...(readInt(record.turnCap) === undefined ? {} : { turnCap: readInt(record.turnCap) }),
    ...(readInt(record.totalToolUseCount) === undefined
      ? {}
      : { toolUses: readInt(record.totalToolUseCount) }),
    ...(readInt(record.totalDurationMs) === undefined
      ? {}
      : { durationMs: readInt(record.totalDurationMs) }),
    ...(readInt(record.totalTokens) === undefined ? {} : { tokens: readInt(record.totalTokens) }),
    truncated: record.resultTruncated === true || body.includes(TRUNCATION_MARK),
  };
}

function parseFiles(value: string): { files: string[]; more?: number } {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none") return { files: [] };
  const more = /\s*\(\+(\d+) more\)\s*$/u.exec(trimmed);
  const list = more ? trimmed.slice(0, more.index) : trimmed;
  return {
    files: list
      .split(", ")
      .map((f) => f.trim())
      .filter(Boolean),
    ...(more ? { more: Number(more[1]) } : {}),
  };
}

export function parseAgentResultSummary(output: unknown): AgentResultSummary | null {
  if (isRecord(output)) return fromRecord(output);
  if (typeof output !== "string" || output.trim().length === 0) return null;
  const text = output.trim();
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) return fromRecord(parsed);
    } catch {
      // not JSON: fall through to the text footer
    }
  }
  // A background launch is not a result yet.
  if (text.startsWith("Async agent launched successfully.")) return null;

  const agentIdAt = text.search(/^agentId: /mu);
  const usage = /<usage>([\s\S]*?)<\/usage>/u.exec(text);
  if (agentIdAt < 0 && !usage) return null;
  const body = (agentIdAt >= 0 ? text.slice(0, agentIdAt) : text.slice(0, usage!.index)).trim();
  const fields = new Map<string, string>();
  for (const line of (usage?.[1] ?? "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const files = fields.has("files_touched") ? parseFiles(fields.get("files_touched")!) : undefined;
  const turnCap = readInt(fields.get("turn_cap"));
  const toolUses = readInt(fields.get("tool_uses"));
  const durationMs = readInt(fields.get("duration_ms"));
  const tokens = readInt(fields.get("subagent_tokens"));
  return {
    body,
    ...(fields.get("model") ? { model: fields.get("model") } : {}),
    ...(files ? { filesTouched: files.files } : {}),
    ...(files?.more ? { moreFiles: files.more } : {}),
    ...(turnCap === undefined ? {} : { turnCap }),
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(tokens === undefined ? {} : { tokens }),
    truncated: body.includes(TRUNCATION_MARK),
  };
}

export function formatAgentDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}
