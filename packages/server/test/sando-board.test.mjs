// Sando board routes (2026-11-03): the Planner token stays server-side, chats resolve session > workspace > project link,
// a missing chat is created with a seed board, and the pick lands in sando-boards.json for the agent runtime.
// Run: pnpm exec tsx --test packages/server/test/sando-board.test.mjs (repo root).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  matchProject,
  normalizeWorkspace,
  parseChatId,
  pickLinkedChat,
  resolvePlannerCredentials,
} from "../src/sandoBoard.ts";
import { registerSandoBoardRoutes } from "../src/sandoBoardRoutes.ts";

const SECRET = "Bearer test-secret-token";

function fakeHome({ withPlugin = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "sando-board-home-"));
  const plugin = join(home, "plugin");
  mkdirSync(join(home, ".zcode", "cli"), { recursive: true });
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(home, ".zcode", "cli", "config.json"),
    JSON.stringify({ plugins: { dirs: withPlugin ? [plugin] : [] } }),
  );
  writeFileSync(
    join(plugin, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        p: { type: "http", url: "http://planner.test/mcp", headers: { Authorization: SECRET } },
      },
    }),
  );
  return home;
}

function fakePlanner({ projects = [], sessions = [] } = {}) {
  const calls = [];
  const boards = new Map(sessions.map((s) => [s.id, s.markdown ?? ""]));
  let nextId = 900;
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push({
      method,
      path: u.pathname,
      auth: init.headers?.Authorization,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (init.headers?.Authorization !== SECRET) return json({ error: "no" }, 401);
    if (method === "GET" && u.pathname === "/api/projects") return json(projects);
    if (method === "GET" && u.pathname === "/api/chat/sessions") return json({ sessions });
    if (method === "POST" && u.pathname === "/api/chat/sessions") {
      const body = JSON.parse(init.body);
      const s = {
        id: nextId++,
        title: body.title,
        scope_project_ids: body.scope_project_ids ? JSON.stringify(body.scope_project_ids) : null,
      };
      sessions.unshift(s);
      boards.set(s.id, "");
      return json({ session: s });
    }
    const m = /^\/api\/chat\/sessions\/(\d+)\/status$/.exec(u.pathname);
    if (m) {
      const id = Number(m[1]);
      if (!boards.has(id)) return json({ error: "Chat not found" }, 404);
      if (method === "PUT") boards.set(id, JSON.parse(init.body).markdown);
      return json({
        status: {
          chat_id: id,
          markdown: boards.get(id),
          url: null,
          updated_at: "2026-11-03 10:00:00",
          updated_by: "t",
        },
      });
    }
    return json({ error: "Not found" }, 404);
  };
  return { fetchImpl, calls, boards };
}

function appWith(home, planner, extra = {}) {
  const app = new Hono();
  const env = { SANDO_BOARDS_FILE: join(home, "boards.json"), ...extra.env };
  registerSandoBoardRoutes(app, {
    env,
    home,
    fetchImpl: planner.fetchImpl,
    gitCommonDir: extra.gitCommonDir ?? (async () => null),
  });
  return { app, boardsFile: env.SANDO_BOARDS_FILE };
}

const post = (app, path, body) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("input validation: chat ids and workspace paths", () => {
  assert.equal(parseChatId("509"), 509);
  for (const bad of ["0", "-1", "1.5", "abc", "", null, "99999999999"])
    assert.equal(parseChatId(bad), null, String(bad));
  assert.equal(normalizeWorkspace("~/apps/ZCode/", "/home/u"), "/home/u/apps/ZCode");
  assert.equal(normalizeWorkspace("/a/../b", "/home/u"), "/b");
  for (const bad of ["relative/path", "", 5, "/a\0b"])
    assert.equal(normalizeWorkspace(bad, "/home/u"), null, String(bad));
});

test("project match: exact path, then folder name (Mac paths), then project name; worktree main checkout counts", () => {
  const projects = [
    { id: 10, name: "Project Planner", local_path: "~/Desktop/Project_Planner" },
    { id: 62, name: "Sando", local_path: "/home/u/apps/ZCode" },
    { id: 28, name: "ShrineTrader", local_path: "~/Desktop/Projects/ShrineTech/ShrineTrader" },
    { id: 72, name: "Tenshi Oni (game)", local_path: null },
  ];
  assert.equal(matchProject(projects, ["/home/u/apps/ZCode"], "/home/u").id, 62);
  assert.equal(matchProject(projects, ["/home/u/apps/ShrineTrader"], "/home/u").id, 28);
  assert.equal(matchProject(projects, ["/home/u/apps/project-planner"], "/home/u").id, 10);
  assert.equal(
    matchProject(projects, ["/home/u/apps/fleet/wt/sando-board", "/home/u/apps/ZCode"], "/home/u")
      .id,
    62,
  );
  assert.equal(matchProject(projects, ["/tmp/unrelated"], "/home/u"), null);
});

test("linked chat: a chat that has a board wins over a newer one without", () => {
  const chats = [
    { id: 3, title: "newer", scope_project_ids: "[62]" },
    { id: 2, title: "has board", scope_project_ids: "[62]", status_updated_at: "2026-11-01" },
    { id: 1, title: "other", scope_project_ids: "[10]", status_updated_at: "2026-11-02" },
  ];
  assert.equal(pickLinkedChat(chats, 62).id, 2);
  assert.equal(pickLinkedChat(chats.slice(0, 1), 62).id, 3);
  assert.equal(pickLinkedChat(chats, 99), null);
});

test("credentials: env wins, else the plugin mcp.json; none -> null", async () => {
  const home = fakeHome();
  assert.deepEqual(await resolvePlannerCredentials({}, home), {
    baseUrl: "http://planner.test",
    authorization: SECRET,
  });
  assert.deepEqual(
    await resolvePlannerCredentials(
      { SANDO_PLANNER_URL: "http://x/", SANDO_PLANNER_TOKEN: "abc" },
      home,
    ),
    {
      baseUrl: "http://x",
      authorization: "Bearer abc",
    },
  );
  assert.equal(await resolvePlannerCredentials({}, fakeHome({ withPlugin: false })), null);
});

test("ensure: uses the project's linked chat and remembers it for the runtime; token never in the response", async () => {
  const home = fakeHome();
  const planner = fakePlanner({
    projects: [{ id: 62, name: "Sando", local_path: "/home/u/apps/ZCode" }],
    sessions: [
      {
        id: 612,
        title: "Sando chat",
        scope_project_ids: "[62]",
        status_updated_at: "x",
        markdown: "## Running now\n- a",
      },
    ],
  });
  const { app, boardsFile } = appWith(home, planner);
  const res = await post(app, "/api/sando/board/ensure", { workspace: "/home/u/apps/ZCode" });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes("test-secret-token"), "token never leaves the server");
  const body = JSON.parse(text);
  assert.equal(body.binding.chatId, 612);
  assert.equal(body.source, "project");
  assert.equal(body.status.markdown, "## Running now\n- a");
  assert.equal(body.link, "https://projects.shrinetech.io/chat/s/612");
  const saved = JSON.parse(readFileSync(boardsFile, "utf8"));
  assert.deepEqual(saved.workspaces["/home/u/apps/ZCode"], { chatId: 612, title: "Sando chat" });
  assert.ok(planner.calls.every((c) => c.auth === SECRET));
  assert.ok(!planner.calls.some((c) => c.method !== "GET"), "nothing created");
});

test("ensure: no linked chat -> creates 'Sando · <project>' scoped to the project with a seed board, once", async () => {
  const home = fakeHome();
  const planner = fakePlanner({
    projects: [{ id: 62, name: "Sando", local_path: "/home/u/apps/ZCode" }],
  });
  const { app } = appWith(home, planner);
  const first = await (
    await post(app, "/api/sando/board/ensure", { workspace: "/home/u/apps/ZCode" })
  ).json();
  assert.equal(first.source, "created");
  assert.equal(first.binding.title, "Sando · Sando");
  const create = planner.calls.find((c) => c.method === "POST");
  assert.deepEqual(create.body, {
    title: "Sando · Sando",
    scope_kind: "project",
    scope_project_ids: [62],
  });
  assert.match(first.status.markdown, /## Running now/);
  assert.match(first.status.markdown, /## Waiting on you/);
  const second = await (
    await post(app, "/api/sando/board/ensure", { workspace: "/home/u/apps/ZCode" })
  ).json();
  assert.equal(second.source, "workspace");
  assert.equal(second.binding.chatId, first.binding.chatId);
  assert.equal(planner.calls.filter((c) => c.method === "POST").length, 1, "created only once");
});

test("pick: a session pick overrides the workspace default; workspace pick clears it", async () => {
  const home = fakeHome();
  const planner = fakePlanner({
    projects: [],
    sessions: [
      { id: 509, title: "Planner Thread" },
      { id: 700, title: "Sando · x" },
    ],
  });
  const { app, boardsFile } = appWith(home, planner);
  const ws = "/home/u/x";
  let r = await (
    await post(app, "/api/sando/board/pick", {
      workspace: ws,
      session: "s-1",
      chatId: 509,
      scope: "session",
    })
  ).json();
  assert.equal(r.source, "session");
  r = await (await post(app, "/api/sando/board/ensure", { workspace: ws, session: "s-1" })).json();
  assert.equal(r.binding.chatId, 509);
  assert.equal(r.source, "session");
  await post(app, "/api/sando/board/pick", {
    workspace: ws,
    session: "s-1",
    chatId: 700,
    scope: "workspace",
  });
  const saved = JSON.parse(readFileSync(boardsFile, "utf8"));
  assert.equal(saved.workspaces[ws].chatId, 700);
  assert.equal(saved.sessions["s-1"], undefined);
});

test("status + chats routes; bad input 400, unknown chat 404, unconfigured 503", async () => {
  const home = fakeHome();
  const planner = fakePlanner({
    sessions: [{ id: 5, title: "t", status_updated_at: "x", markdown: "hi" }],
  });
  const { app } = appWith(home, planner);
  assert.equal(
    (await (await app.request("/api/sando/board/status?chat=5")).json()).status.markdown,
    "hi",
  );
  assert.equal((await app.request("/api/sando/board/status?chat=abc")).status, 400);
  assert.equal((await app.request("/api/sando/board/status?chat=77")).status, 404);
  assert.deepEqual((await (await app.request("/api/sando/board/chats")).json()).chats, [
    { id: 5, title: "t", hasBoard: true, updatedAt: null },
  ]);
  assert.equal((await post(app, "/api/sando/board/ensure", { workspace: "relative" })).status, 400);
  assert.equal(
    (await post(app, "/api/sando/board/pick", { workspace: "/a", chatId: "x" })).status,
    400,
  );

  const bare = appWith(fakeHome({ withPlugin: false }), planner).app;
  assert.equal((await bare.request("/api/sando/board/status?chat=5")).status, 503);
});
