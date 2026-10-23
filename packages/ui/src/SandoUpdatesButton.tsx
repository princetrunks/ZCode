// Sando "Updates" bell (2026-10-23): the latest notes posted into the Planner's main chat (finished fleet workers, deploys,
// watchers), read-only through GET /api/sando/planner-notes (the server holds the Planner token). Hidden when the endpoint is
// not there (desktop builds, older servers). Plain text only; "Open" goes to the Planner.
import { memo, useCallback, useEffect, useState } from "react";
import { Bell, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import {
  UPDATES_SEEN_KEY,
  newestId,
  unreadUpdates,
  updateAge,
  updateLink,
  updatePreview,
  type SandoUpdate,
} from "@/lib/sandoUpdates.js";

interface NotesResponse {
  ok: boolean;
  notes: SandoUpdate[];
  chatId: number;
  plannerUrl: string;
  error?: string;
}

const POLL_MS = 60_000;

function readSeen(): number | null {
  try {
    const v = Number(localStorage.getItem(UPDATES_SEEN_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export const SandoUpdatesButton = memo(function SandoUpdatesButton() {
  const [data, setData] = useState<NotesResponse | null>(null);
  const [available, setAvailable] = useState(true);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<number | null>(readSeen);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/sando/planner-notes?limit=20", { credentials: "same-origin" });
      if (res.status === 404) return setAvailable(false);
      if (!res.ok) return;
      setData((await res.json()) as NotesResponse);
    } catch {
      /* offline: keep what we have */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) void load();
      if (!next && data?.notes.length) {
        const top = newestId(data.notes);
        if (top != null) {
          try { localStorage.setItem(UPDATES_SEEN_KEY, String(top)); } catch { /* private mode */ }
          setSeen(top);
        }
      }
    },
    [data, load],
  );

  if (!available) return null;
  const notes = data?.notes ?? [];
  const unread = unreadUpdates(notes, seen);
  const label = unread ? `Updates (${unread} new)` : "Updates";

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-lg" aria-label={label} title={label} className="relative">
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-warning" aria-hidden="true" data-sando-updates-dot />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-[min(22rem,calc(100vw-1.5rem))] max-h-[min(32rem,70vh)] gap-0 overflow-y-auto bg-menu p-0"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2 text-ui-base font-medium">
          <span>📣 Updates</span>
          {data && (
            <a className="text-ui-sm text-foreground-subtle hover:text-foreground" href={updateLink(null, data.plannerUrl, data.chatId)} target="_blank" rel="noopener noreferrer">
              Planner chat
            </a>
          )}
        </div>
        {data && !data.ok && <p className="px-3 py-3 text-ui-sm text-foreground-subtle">{data.error ?? "Could not load updates."}</p>}
        {data?.ok && notes.length === 0 && <p className="px-3 py-3 text-ui-sm text-foreground-subtle">No updates yet.</p>}
        {!data && <p className="px-3 py-3 text-ui-sm text-foreground-subtle">Loading…</p>}
        <ul className="divide-y divide-border">
          {notes.map((n) => (
            <li key={n.id} className={cn("px-3 py-2", seen != null && n.id > seen && "bg-surface-hover")}>
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 break-words text-ui-base font-medium">{n.title}</span>
                <span className="shrink-0 text-ui-sm text-foreground-subtle">
                  {n.kind !== "fleet" ? `${n.kind} · ` : ""}{updateAge(n.created_at)}
                </span>
              </div>
              <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle">{updatePreview(n.body)}</p>
              <a
                className="mt-1 inline-flex items-center gap-1 text-ui-sm text-foreground-subtle hover:text-foreground"
                href={updateLink(n.link, data?.plannerUrl ?? "https://projects.shrinetech.io", data?.chatId ?? 509)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open <ExternalLink className="size-3" />
              </a>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
});
