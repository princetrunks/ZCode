// Sando board (2026-11-03): the Planner chat whose status board sits in the workbench "Board" side pane.
// The web server writes the mapping file when the pane picks or creates a chat; the runtime (another process) reads it
// every time the context prefix is built and tells the model which chat id to keep current with update_chat_status.
// No mapping, no section: request bodies stay byte-identical for sessions without a board.
//
// File: ~/.zcode/v2/sando-boards.json (override: SANDO_BOARDS_FILE)
//   { "version": 1,
//     "workspaces": { "<workspace path>": { "chatId": 123, "title": "Sando · ZCode" } },
//     "sessions":   { "<session id>":     { "chatId": 456, "title": "…" } } }
// A session pick wins over the workspace default.
//
// The read is synchronous on purpose: createContextBuilderFromSnapshot and rebuildContextPrefix are synchronous and
// run per model step. A stat + mtime cache keeps it to one small read per change.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SandoBoardBinding {
  chatId: number;
  title?: string;
}

interface SandoBoardsFile {
  workspaces?: Record<string, SandoBoardBinding | undefined>;
  sessions?: Record<string, SandoBoardBinding | undefined>;
}

export function resolveSandoBoardsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SANDO_BOARDS_FILE?.trim();
  return override || join(homedir(), ".zcode", "v2", "sando-boards.json");
}

let cache: { path: string; mtimeMs: number; size: number; data: SandoBoardsFile } | null = null;

function readBoardsFile(path: string): SandoBoardsFile {
  let st;
  try {
    st = statSync(path);
  } catch {
    return {};
  }
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.data;
  }
  let data: SandoBoardsFile = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object") data = parsed as SandoBoardsFile;
  } catch {
    data = {};
  }
  cache = { path, mtimeMs: st.mtimeMs, size: st.size, data };
  return data;
}

function validBinding(value: unknown): SandoBoardBinding | null {
  if (!value || typeof value !== "object") return null;
  const chatId = Number((value as { chatId?: unknown }).chatId);
  if (!Number.isInteger(chatId) || chatId <= 0) return null;
  const rawTitle = (value as { title?: unknown }).title;
  const title = typeof rawTitle === "string" ? rawTitle.slice(0, 120) : undefined;
  return title ? { chatId, title } : { chatId };
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/[/\\]+$/u, "") : p);

export function resolveSandoBoardBinding(
  options: { sessionId?: string; workspacePath?: string },
  filePath: string = resolveSandoBoardsFilePath(),
): SandoBoardBinding | null {
  const data = readBoardsFile(filePath);
  if (options.sessionId) {
    const hit = validBinding(data.sessions?.[options.sessionId]);
    if (hit) return hit;
  }
  if (options.workspacePath) {
    const hit = validBinding(data.workspaces?.[trimSlash(options.workspacePath)]);
    if (hit) return hit;
  }
  return null;
}

export function buildSandoBoardSection(binding: SandoBoardBinding): string {
  // The title came from the Planner (the user's own data) but it is still quoted, never interpreted as instructions.
  const label = binding.title ? ` (${JSON.stringify(binding.title)})` : "";
  return [
    "# Status board",
    `The user watches a short status board for this session beside the chat: Planner chat #${binding.chatId}${label}.`,
    `Keep it current with the Planner MCP tool update_chat_status, always passing chat_id ${binding.chatId}. ` +
      "Edit ONE `## section` per call (e.g. \"Running now\", \"Done\", \"Waiting on you\") after meaningful progress: " +
      "something finished, started, got blocked, or now needs the user. Short factual bullets; a glance board, not a log. " +
      'Use mode "read" to see it first. If the tool is not available, carry on without it.',
  ].join("\n");
}
