// Sando: "Updates" from the ShrineTech Planner (2026-10-23). Finished fleet workers, deploys and watchers post a note into the
// Planner's main chat (509); the workbench lists them read-only. The Planner JWT stays on the server: it is read from the
// shrinetech-planner plugin's gitignored mcp.json (the same token the plugin's MCP uses), never sent to the browser.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PlannerNote {
  id: number;
  title: string;
  kind: string;
  link: string | null;
  body: string;
  created_at: string | null;
}

export interface PlannerNotesConfig {
  mcpJsonPath: string;
  baseUrl: string;
  publicUrl: string;
  chatId: number;
}

export function plannerNotesConfig(env: NodeJS.ProcessEnv = process.env): PlannerNotesConfig {
  const chat = Number(env.SANDO_PLANNER_CHAT ?? "509");
  return {
    mcpJsonPath: env.SANDO_PLANNER_MCP_JSON?.trim() || join(homedir(), "apps/ZCode/plugins/shrinetech-planner/mcp.json"),
    baseUrl: (env.SANDO_PLANNER_URL?.trim() || "http://127.0.0.1:4001").replace(/\/+$/, ""),
    publicUrl: (env.SANDO_PLANNER_PUBLIC_URL?.trim() || "https://projects.shrinetech.io").replace(/\/+$/, ""),
    chatId: Number.isInteger(chat) && chat > 0 ? chat : 509,
  };
}

/** The Bearer token from the plugin's mcp.json ({mcpServers:{...}} or a bare map); null when absent or malformed. */
export function plannerTokenFromMcpJson(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const root = (parsed as { mcpServers?: unknown })?.mcpServers ?? parsed;
  const server = (root as Record<string, { headers?: Record<string, string> } | undefined>)?.["shrinetech-planner"];
  const auth = server?.headers?.Authorization ?? server?.headers?.authorization ?? "";
  const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(String(auth).trim());
  return m?.[1] ?? null;
}

/** `since` is passed through only when it is a message id or an ISO-ish time (no injection into the Planner query). */
export function plannerNotesUrl(cfg: PlannerNotesConfig, since?: string | null, limit = 20): string {
  const q = new URLSearchParams({ limit: String(Math.max(1, Math.min(50, Math.trunc(limit) || 20))) });
  const s = String(since ?? "").trim();
  if (/^\d{1,12}$/.test(s) || /^\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?$/.test(s)) q.set("since", s);
  return `${cfg.baseUrl}/api/chat/sessions/${cfg.chatId}/notes?${q.toString()}`;
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface PlannerNotesResult {
  ok: boolean;
  notes: PlannerNote[];
  chatId: number;
  plannerUrl: string;
  error?: string;
}

/** Read the token, GET the Planner, return a trimmed list. Never throws; errors come back as { ok: false, error }. */
export async function fetchPlannerNotes(
  cfg: PlannerNotesConfig,
  opts: { since?: string | null; limit?: number; fetchImpl?: FetchLike; readToken?: () => Promise<string> } = {},
): Promise<PlannerNotesResult> {
  const base = { chatId: cfg.chatId, plannerUrl: cfg.publicUrl };
  let token: string | null = null;
  try {
    token = plannerTokenFromMcpJson(await (opts.readToken ?? (() => readFile(cfg.mcpJsonPath, "utf8")))());
  } catch {
    token = null;
  }
  if (!token) return { ok: false, notes: [], ...base, error: "No Planner token (shrinetech-planner mcp.json missing or malformed)" };
  try {
    const res = await (opts.fetchImpl ?? (fetch as unknown as FetchLike))(plannerNotesUrl(cfg, opts.since, opts.limit), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, notes: [], ...base, error: `Planner answered HTTP ${res.status}` };
    const data = (await res.json()) as { notes?: unknown };
    const notes = (Array.isArray(data?.notes) ? data.notes : []).flatMap((n): PlannerNote[] => {
      const r = n as Partial<PlannerNote>;
      if (typeof r?.id !== "number" || typeof r.title !== "string") return [];
      return [{
        id: r.id,
        title: r.title.slice(0, 200),
        kind: typeof r.kind === "string" ? r.kind : "fleet",
        link: typeof r.link === "string" ? r.link : null,
        body: typeof r.body === "string" ? r.body.slice(0, 8000) : "",
        created_at: typeof r.created_at === "string" ? r.created_at : null,
      }];
    });
    return { ok: true, notes, ...base };
  } catch (err: unknown) {
    return { ok: false, notes: [], ...base, error: `Planner unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
