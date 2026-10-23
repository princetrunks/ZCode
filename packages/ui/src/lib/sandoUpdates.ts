// Sando "Updates" bell (2026-10-23): pure helpers for the Planner notes list (server: packages/server/src/plannerNotes.ts).
export interface SandoUpdate {
  id: number;
  title: string;
  kind: string;
  link: string | null;
  body: string;
  created_at: string | null;
}

export const UPDATES_SEEN_KEY = "sando.updatesSeenId";

/** Notes newer than the last one opened. */
export function unreadUpdates(notes: readonly SandoUpdate[], seenId: number | null): number {
  if (seenId == null) return notes.length ? 1 : 0; // first run: one dot, not a wall of old updates
  return notes.filter((n) => n.id > seenId).length;
}

export function newestId(notes: readonly SandoUpdate[]): number | null {
  return notes.reduce<number | null>((m, n) => (m == null || n.id > m ? n.id : m), null);
}

/** In-app Planner paths become absolute on the public Planner; only http(s) survives. */
export function updateLink(link: string | null, plannerUrl: string, chatId: number): string {
  const base = plannerUrl.replace(/\/+$/, "");
  const l = String(link ?? "").trim();
  if (/^https?:\/\//i.test(l)) return l;
  if (/^\/(?!\/)/.test(l)) return `${base}${l}`;
  return `${base}/chat/s/${chatId}`;
}

/** "5m", "3h", "2d" from a Planner UTC timestamp ("2026-10-23 14:02:11"). */
export function updateAge(createdAt: string | null, now = Date.now()): string {
  if (!createdAt) return "";
  const s = createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

/** First lines of a markdown body as plain text for the list (no HTML is ever rendered). */
export function updatePreview(body: string, max = 280): string {
  const text = body.replace(/```[\s\S]*?```/g, "[code]").replace(/[*_`#>]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
