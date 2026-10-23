// Sando "Updates" bell helpers. Run: pnpm exec tsx --test packages/ui/test/sandoUpdates.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { newestId, unreadUpdates, updateAge, updateLink, updatePreview, type SandoUpdate } from "../src/lib/sandoUpdates.js";

const n = (id: number, extra: Partial<SandoUpdate> = {}): SandoUpdate => ({ id, title: `t${id}`, kind: "fleet", link: null, body: "b", created_at: null, ...extra });

test("unread counts notes past the last one opened; first run shows one dot, not a wall", () => {
  const notes = [n(30), n(20), n(10)];
  assert.equal(unreadUpdates(notes, 20), 1);
  assert.equal(unreadUpdates(notes, 30), 0);
  assert.equal(unreadUpdates(notes, null), 1);
  assert.equal(unreadUpdates([], null), 0);
  assert.equal(newestId(notes), 30);
  assert.equal(newestId([]), null);
});

test("links: in-app paths go to the public Planner, http(s) kept, anything else falls back to the chat", () => {
  const P = "https://projects.shrinetech.io/";
  assert.equal(updateLink("/chat/s/509", P, 509), "https://projects.shrinetech.io/chat/s/509");
  assert.equal(updateLink("https://github.com/x", P, 509), "https://github.com/x");
  assert.equal(updateLink("javascript:alert(1)", P, 509), "https://projects.shrinetech.io/chat/s/509");
  assert.equal(updateLink("//evil.example", P, 509), "https://projects.shrinetech.io/chat/s/509");
  assert.equal(updateLink(null, P, 296), "https://projects.shrinetech.io/chat/s/296");
});

test("age from a Planner UTC timestamp; preview is plain text", () => {
  const now = Date.parse("2026-10-23T15:00:00Z");
  assert.equal(updateAge("2026-10-23 14:55:00", now), "5m");
  assert.equal(updateAge("2026-10-23 12:00:00", now), "3h");
  assert.equal(updateAge("2026-10-20 15:00:00", now), "3d");
  assert.equal(updateAge(null, now), "");
  assert.equal(updatePreview("**Done.** `x`\n```\ncode\n```"), "Done. x\n[code]");
  assert.equal(updatePreview("y".repeat(500), 10).length, 10);
});
