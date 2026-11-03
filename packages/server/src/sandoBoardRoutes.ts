// Sando board routes (2026-11-03): the HTTP surface of sandoBoard.ts. See that file for the contract.
import { homedir } from "node:os";
import type { Hono } from "hono";
import {
  createSandoBoardService,
  normalizeWorkspace,
  parseChatId,
  PlannerError,
  type BoardBinding,
  type BoardStatus,
  type SandoBoardOptions,
} from "./sandoBoard.js";

function errorResponse(err: unknown): { body: { error: string }; status: 400 | 404 | 502 | 503 } {
  if (err instanceof PlannerError) {
    const status = err.status === 404 || err.status === 503 ? err.status : 502;
    return { body: { error: err.message }, status };
  }
  return { body: { error: err instanceof Error ? err.message : String(err) }, status: 502 };
}

const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const parseSession = (raw: unknown) =>
  typeof raw === "string" && SESSION_ID.test(raw) ? raw : null;

/** Registers the routes; call after the auth middleware so they sit behind the lite-token cookie. */
export function registerSandoBoardRoutes(app: Hono, options: SandoBoardOptions = {}) {
  const service = createSandoBoardService(options);
  const home = options.home ?? homedir();
  const view = (r: { binding: BoardBinding; source: string; status: BoardStatus }) => ({
    binding: r.binding,
    source: r.source,
    status: r.status,
    link: service.chatLink(r.binding.chatId),
  });

  app.post("/api/sando/board/ensure", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      workspace?: unknown;
      session?: unknown;
    } | null;
    const workspace = normalizeWorkspace(body?.workspace, home);
    if (!workspace) return c.json({ error: "workspace must be an absolute path" }, 400);
    try {
      return c.json(
        view(await service.ensure({ workspace, session: parseSession(body?.session) })),
      );
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  app.post("/api/sando/board/pick", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const workspace = normalizeWorkspace(body?.workspace, home);
    const chatId = parseChatId(body?.chatId);
    const scope = body?.scope === "session" ? "session" : "workspace";
    if (!workspace || !chatId) return c.json({ error: "workspace and chatId are required" }, 400);
    try {
      return c.json(
        view(
          await service.pick({ workspace, session: parseSession(body?.session), chatId, scope }),
        ),
      );
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/api/sando/board/status", async (c) => {
    const chatId = parseChatId(c.req.query("chat"));
    if (!chatId) return c.json({ error: "chat is required" }, 400);
    try {
      return c.json({ status: await service.getStatus(chatId) });
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  app.get("/api/sando/board/chats", async (c) => {
    try {
      const chats = await service.listChats();
      return c.json({
        chats: chats.slice(0, 200).map((x) => ({
          id: x.id,
          title: x.title,
          hasBoard: Boolean(x.status_updated_at),
          updatedAt: x.updated_at ?? null,
        })),
      });
    } catch (err) {
      const e = errorResponse(err);
      return c.json(e.body, e.status);
    }
  });

  return service;
}
