// Sando board (2026-11-03): client side of the web server's /api/sando/board/* routes (packages/server/src/sandoBoard.ts).
// The server holds the Planner token; the browser only sends the workspace path, the session id and chat ids.
import { plannerOrigin } from "@/lib/audioSpec.js";

export type SandoBoardSource = "session" | "workspace" | "project" | "created";

export interface SandoBoardStatus {
  chat_id: number;
  markdown: string;
  url: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export interface SandoBoardView {
  binding: { chatId: number; title?: string };
  source: SandoBoardSource;
  status: SandoBoardStatus;
  link: string;
}

export interface SandoBoardChat {
  id: number;
  title: string;
  hasBoard: boolean;
  updatedAt: string | null;
}

export const SANDO_BOARD_POLL_MS = 10_000;

async function call<T>(path: string, init?: { method: "POST"; body: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    ...(init
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }
      : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function ensureSandoBoard(
  workspace: string,
  session: string | null,
): Promise<SandoBoardView> {
  return call("/api/sando/board/ensure", { method: "POST", body: { workspace, session } });
}

export function pickSandoBoard(input: {
  workspace: string;
  session: string | null;
  chatId: number;
  scope: "session" | "workspace";
}): Promise<SandoBoardView> {
  return call("/api/sando/board/pick", { method: "POST", body: input });
}

export async function fetchSandoBoardStatus(chatId: number): Promise<SandoBoardStatus> {
  return (await call<{ status: SandoBoardStatus }>(`/api/sando/board/status?chat=${chatId}`))
    .status;
}

export async function listSandoBoardChats(): Promise<SandoBoardChat[]> {
  return (await call<{ chats: SandoBoardChat[] }>("/api/sando/board/chats")).chats;
}

/**
 * Board media is stored with Planner-relative paths (`![](/api/lily/media/…)`); seen from Sando those must point at the
 * Planner. Only root-relative targets of markdown links/images change; absolute and protocol-relative URLs stay.
 */
export function absolutizePlannerLinks(markdown: string, origin: string = plannerOrigin()): string {
  return markdown.replace(/(\]\()\/(?!\/)/gu, `$1${origin}/`);
}

/** Planner timestamps are UTC "YYYY-MM-DD HH:MM:SS". */
export function parsePlannerTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/u.test(value) ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : null;
}

/** Chats for the picker: the current one first, then those with a board, then the rest (server order = newest). */
export function orderPickerChats(
  chats: readonly SandoBoardChat[],
  currentId: number | null,
): SandoBoardChat[] {
  const rank = (c: SandoBoardChat) => (c.id === currentId ? 0 : c.hasBoard ? 1 : 2);
  return chats
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}
