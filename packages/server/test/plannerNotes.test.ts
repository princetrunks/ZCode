// Sando Updates proxy. Run: pnpm exec tsx --test packages/server/test/plannerNotes.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { fetchPlannerNotes, plannerNotesConfig, plannerNotesUrl, plannerTokenFromMcpJson } from "../src/plannerNotes.js";

const cfg = plannerNotesConfig({ SANDO_PLANNER_URL: "http://127.0.0.1:4001/", SANDO_PLANNER_CHAT: "509" } as NodeJS.ProcessEnv);
const MCP = JSON.stringify({ mcpServers: { "shrinetech-planner": { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer aaa.bbb.ccc" } } } });

test("token from the plugin's mcp.json (wrapper or bare map); junk gives null", () => {
  assert.equal(plannerTokenFromMcpJson(MCP), "aaa.bbb.ccc");
  assert.equal(plannerTokenFromMcpJson(JSON.stringify({ "shrinetech-planner": { headers: { Authorization: "Bearer t.u.v" } } })), "t.u.v");
  assert.equal(plannerTokenFromMcpJson("{nope"), null);
  assert.equal(plannerTokenFromMcpJson(JSON.stringify({ mcpServers: { other: {} } })), null);
  assert.equal(plannerTokenFromMcpJson(JSON.stringify({ mcpServers: { "shrinetech-planner": { headers: { Authorization: "Bearer <PLANNER_JWT from POST>" } } } })), null);
});

test("url: chat 509 by default, since only when it is an id or a time, limit clamped", () => {
  assert.equal(plannerNotesUrl(cfg), "http://127.0.0.1:4001/api/chat/sessions/509/notes?limit=20");
  assert.match(plannerNotesUrl(cfg, "1234", 500), /notes\?limit=50&since=1234$/);
  assert.match(plannerNotesUrl(cfg, "2026-10-23T10:00:00Z"), /since=2026-10-23T10%3A00%3A00Z/);
  assert.doesNotMatch(plannerNotesUrl(cfg, "1&user=2"), /since/);
  assert.equal(plannerNotesConfig({ SANDO_PLANNER_CHAT: "x" } as NodeJS.ProcessEnv).chatId, 509);
});

test("fetch: sends the token server-side, trims the list, never throws", async () => {
  let seen: { url: string; auth: string } | null = null;
  const ok = await fetchPlannerNotes(cfg, {
    readToken: async () => MCP,
    fetchImpl: async (url, init) => {
      seen = { url, auth: init.headers.Authorization };
      return { ok: true, status: 200, json: async () => ({ notes: [{ id: 7, title: "Done", kind: "deploy", link: "/chat/s/509", body: "b", created_at: "2026-10-23 10:00:00" }, { bogus: true }] }) };
    },
  });
  assert.deepEqual(seen, { url: "http://127.0.0.1:4001/api/chat/sessions/509/notes?limit=20", auth: "Bearer aaa.bbb.ccc" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.notes.map((x) => x.id), [7]);
  assert.equal(JSON.stringify(ok).includes("aaa.bbb.ccc"), false, "the token never goes back to the browser");

  const noTok = await fetchPlannerNotes(cfg, { readToken: async () => { throw new Error("ENOENT"); } });
  assert.equal(noTok.ok, false);
  assert.match(noTok.error ?? "", /No Planner token/);
  const http = await fetchPlannerNotes(cfg, { readToken: async () => MCP, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  assert.match(http.error ?? "", /HTTP 401/);
  const down = await fetchPlannerNotes(cfg, { readToken: async () => MCP, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.match(down.error ?? "", /unreachable/);
});
