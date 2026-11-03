// Sando board pane helpers + side-pane wiring. Run: pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/sandoBoard.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  absolutizePlannerLinks,
  orderPickerChats,
  parsePlannerTime,
} from "../src/lib/sandoBoard.js";
import { resolveOpenTabLauncherItemIds } from "../src/app-shell/animatedSidePanePanelModel.js";
import { activateSandoBoardSidePane } from "../src/lib/workspaceSidePane.js";

test("board media paths point at the Planner; absolute and protocol-relative URLs stay", () => {
  const o = "https://projects.shrinetech.io";
  assert.equal(
    absolutizePlannerLinks(
      "![shot](/api/lily/media/a.png) [doc](https://x.io/a) [cdn](//cdn/x) [rel](notes.md)",
      o,
    ),
    `![shot](${o}/api/lily/media/a.png) [doc](https://x.io/a) [cdn](//cdn/x) [rel](notes.md)`,
  );
  assert.equal(absolutizePlannerLinks("no links / here", o), "no links / here");
});

test("Planner UTC timestamps parse", () => {
  assert.equal(parsePlannerTime("2026-11-03 10:00:00"), Date.UTC(2026, 10, 3, 10, 0, 0));
  assert.equal(parsePlannerTime("2026-11-03T10:00:00Z"), Date.UTC(2026, 10, 3, 10, 0, 0));
  assert.equal(parsePlannerTime(null), null);
  assert.equal(parsePlannerTime("nope"), null);
});

test("picker order: current, then chats with a board, then the rest (stable)", () => {
  const chats = [
    { id: 1, title: "a", hasBoard: false, updatedAt: null },
    { id: 2, title: "b", hasBoard: true, updatedAt: null },
    { id: 3, title: "c", hasBoard: false, updatedAt: null },
    { id: 4, title: "d", hasBoard: true, updatedAt: null },
  ];
  assert.deepEqual(
    orderPickerChats(chats, 3).map((c) => c.id),
    [3, 2, 4, 1],
  );
});

test("launcher offers Board only when enabled (web workbench)", () => {
  const base = { developerToolsEnabled: false, hasReviewTab: true };
  assert.ok(!resolveOpenTabLauncherItemIds(base).includes("sando-board"));
  assert.ok(
    resolveOpenTabLauncherItemIds({ ...base, sandoBoardEnabled: true }).includes("sando-board"),
  );
});

test("opening the Board twice keeps one tab and activates it", () => {
  const once = activateSandoBoardSidePane(null);
  const twice = activateSandoBoardSidePane(once);
  assert.equal(twice.tabs.filter((t) => t.type === "sando-board").length, 1);
  assert.equal(twice.activeTabId, "sando-board");
});
