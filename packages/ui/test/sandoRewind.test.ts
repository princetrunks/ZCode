// Sando: the Rewind dialog's pure helpers (ACK reading, ordering, coverage, force).
// Run: pnpm exec tsx --test packages/ui/test/sandoRewind.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REWIND_IGNORED_REASON_KEYS,
  canForce,
  newestFirst,
  readRewindActionAck,
  readRewindListAck,
  rewindCoverage,
} from "../src/lib/sandoRewind.ts";
import { V4_WORKSPACE_FILE_REWIND_IGNORED_REASONS } from "../../shared/src/zcode-protocol-v4/transport.ts";
import enUS from "../src/i18n/locales/en-US.ts";
import zhCN from "../src/i18n/locales/zh-CN.ts";

const point = (turn: number, edits: number, shells: number) => ({
  turn,
  messageId: `msg_${turn}`,
  preview: `turn ${turn}`,
  createdAt: turn,
  editCount: 1,
  editedFiles: ["a.txt"],
  shellCommandCount: 0,
  editCountFromHere: edits,
  shellCommandCountFromHere: shells,
});

const ack = (extra: Record<string, unknown>) =>
  ({ commandId: "c1", revisionAtDecision: 0, status: "accepted", ...extra }) as never;

test("readRewindListAck: accepted list, rejected guard, missing result", () => {
  const ok = readRewindListAck(
    ack({ result: { type: "listRewindPoints", points: [point(1, 2, 0)], undo: null } }),
  );
  assert.equal(ok.ok, true);
  const busy = readRewindListAck(ack({ status: "failed", reasonCode: "guard.rewindWhileRunning" }));
  assert.deepEqual(busy, { ok: false, reasonCode: "guard.rewindWhileRunning" });
  assert.deepEqual(readRewindListAck(ack({})), { ok: false, reasonCode: "fault.missingResult" });
});

test("readRewindActionAck + canForce: blocked files offer force, applied results do not", () => {
  const blocked = {
    type: "rewindToTurn",
    applied: false,
    response: "not applied",
    restoredFiles: [],
    skippedFiles: [],
    blockedFiles: [{ path: "/w/a.txt", reason: "external_modified", operationCount: 1, toolNames: ["Write"] }],
    conversationRewound: false,
    shellCommandCount: 0,
    undo: null,
  };
  const outcome = readRewindActionAck(ack({ result: blocked }));
  assert.equal(outcome.ok, true);
  assert.equal(canForce(outcome.ok ? outcome.result : null), true);
  assert.equal(canForce({ ...blocked, applied: true, blockedFiles: [] } as never), false);
  assert.equal(readRewindActionAck(ack({ result: { type: "listRewindPoints", points: [], undo: null } })).ok, false);
});

test("newestFirst and rewindCoverage", () => {
  assert.deepEqual(
    newestFirst([point(1, 3, 1), point(3, 1, 0), point(2, 2, 1)]).map((p) => p.turn),
    [3, 2, 1],
  );
  assert.deepEqual(rewindCoverage(point(2, 4, 1), "both"), { fileEdits: 4, laterTurns: 2, shellCommands: 1 });
  assert.deepEqual(rewindCoverage(point(2, 4, 1), "conversation"), { fileEdits: 0, laterTurns: 2, shellCommands: 1 });
  assert.deepEqual(rewindCoverage(point(2, 4, 1), "files"), { fileEdits: 4, laterTurns: 0, shellCommands: 1 });
});

test("every rewind reason and dialog string has en-US and zh-CN text", () => {
  for (const reason of V4_WORKSPACE_FILE_REWIND_IGNORED_REASONS) {
    assert.ok(REWIND_IGNORED_REASON_KEYS[reason], `reason ${reason} has a key`);
  }
  const keys = [
    ...Object.values(REWIND_IGNORED_REASON_KEYS),
    ...Object.keys(enUS).filter((key) => key.startsWith("sando.rewind.")),
  ];
  for (const key of keys) {
    assert.equal(typeof (enUS as Record<string, string>)[key], "string", `en-US ${key}`);
    assert.equal(typeof (zhCN as Record<string, string>)[key], "string", `zh-CN ${key}`);
  }
});
