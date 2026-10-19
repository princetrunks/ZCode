// Sando: checkpoint caps, prune selection, /rewind parsing, the turn model and the list wording (pure functions from
// dist). The end-to-end flow (real tools, real session store, undo) is cli/test/sando-rewind.e2e.test.mjs.
// Run: pnpm --filter @zcode/core build && pnpm exec tsx --test test/sando-rewind.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const limits = await import("../dist/runtime/helpers/sando-checkpoint-limits.js");
const { parseRewindCommand, stringifyWorkspaceCheckpointArtifact } = await import(
  "../dist/runtime/helpers/index.js"
);
const { buildRewindPoints, formatRewindPointList, resolveRewindPoint, SHELL_SIDE_EFFECTS_NOTE } =
  await import("../dist/runtime/methods/sando-rewind.js");
const { isPathAllowedByConfinement } = await import("../dist/tool/path-policy.js");

test("checkpointOmittedReason: text under the cap is stored, big or binary content is not", () => {
  assert.equal(limits.checkpointOmittedReason(["hello", "world"], 64), undefined);
  assert.equal(limits.checkpointOmittedReason([null, "x".repeat(65)], 64), "too_large");
  assert.equal(limits.checkpointOmittedReason(["é".repeat(40)], 64), "too_large", "UTF-8 bytes, not chars");
  assert.equal(limits.checkpointOmittedReason(["a\u0000b"], 64), "binary");
  assert.equal(limits.checkpointOmittedReason([null, undefined], 64), undefined);
});

test("cap env vars: positive integers override, anything else falls back to the defaults", () => {
  assert.equal(limits.checkpointMaxFileBytes({ SANDO_CHECKPOINT_MAX_FILE_BYTES: "1000" }), 1000);
  assert.equal(limits.checkpointMaxFileBytes({ SANDO_CHECKPOINT_MAX_FILE_BYTES: "-5" }), 2 * 1024 * 1024);
  assert.equal(limits.checkpointSessionBudgetBytes({}), 256 * 1024 * 1024);
});

test("stringifyWorkspaceCheckpointArtifact: an oversized file keeps its record but not its text", () => {
  const before = process.env.SANDO_CHECKPOINT_MAX_FILE_BYTES;
  process.env.SANDO_CHECKPOINT_MAX_FILE_BYTES = "16";
  try {
    const result = { toolCallId: "t1", toolName: "Write" };
    const big = JSON.parse(
      stringifyWorkspaceCheckpointArtifact(
        { filePath: "big.txt", originalFile: "small", content: "x".repeat(32), structuredPatch: [] },
        result,
      ),
    );
    assert.equal(big.files[0].omitted, "too_large");
    assert.equal(big.files[0].beforeContent, null);
    assert.equal(big.files[0].existedBefore, true, "existence is still recorded truthfully");
    assert.equal(big.files[0].afterContent, undefined);
    const small = JSON.parse(
      stringifyWorkspaceCheckpointArtifact(
        { filePath: "a.txt", originalFile: "one", content: "two", structuredPatch: [] },
        result,
      ),
    );
    assert.equal(small.files[0].omitted, undefined);
    assert.equal(small.files[0].beforeContent, "one");
    assert.equal(small.files[0].afterContent, "two");
  } finally {
    if (before === undefined) delete process.env.SANDO_CHECKPOINT_MAX_FILE_BYTES;
    else process.env.SANDO_CHECKPOINT_MAX_FILE_BYTES = before;
  }
});

test("selectCheckpointsToPrune: oldest first until within budget, never the newest, unsized ones kept", () => {
  const cps = [
    { id: "a", artifactBytes: 100 },
    { id: "b" },
    { id: "c", artifactBytes: 100 },
    { id: "d", artifactBytes: 100 },
  ];
  assert.deepEqual(limits.selectCheckpointsToPrune(cps, 1000), []);
  assert.deepEqual(
    limits.selectCheckpointsToPrune(cps, 150).map((cp) => cp.id),
    ["a", "c"],
  );
  assert.deepEqual(
    limits.selectCheckpointsToPrune([{ id: "only", artifactBytes: 999 }], 1).map((cp) => cp.id),
    [],
    "the checkpoint just written is never pruned, even alone over budget",
  );
});

test("parseRewindCommand: list / to / undo, scope words and force; old forms unchanged", () => {
  assert.deepEqual(parseRewindCommand("/rewind list"), { action: "list" });
  assert.deepEqual(parseRewindCommand("/rewind to 3"), {
    action: "to",
    force: false,
    scope: "both",
    target: "3",
  });
  assert.deepEqual(parseRewindCommand("/rewind to 2 files force"), {
    action: "to",
    force: true,
    scope: "workspace",
    target: "2",
  });
  assert.deepEqual(parseRewindCommand("/rewind to msg_abc conversation"), {
    action: "to",
    force: false,
    scope: "conversation",
    target: "msg_abc",
  });
  assert.deepEqual(parseRewindCommand("/rewind undo"), { action: "undo", force: false });
  assert.deepEqual(parseRewindCommand("/rewind undo force"), { action: "undo", force: true });
  // Upstream forms keep their meaning.
  assert.deepEqual(parseRewindCommand("/rewind"), { action: "status" });
  assert.deepEqual(parseRewindCommand("/rewind latest"), { action: "apply" });
  assert.deepEqual(parseRewindCommand("/rewind both msg_1"), {
    action: "message",
    scope: "both",
    targetMessageId: "msg_1",
  });
  // A bad scope word after `to` is not silently turned into a checkpoint id.
  assert.deepEqual(parseRewindCommand("/rewind to 2 everything"), {
    action: "apply",
    targetCheckpointId: "to 2 everything",
  });
});

const user = (id, text, extra = {}) => ({
  info: { id, role: "user", time: { created: 1 }, ...extra },
  parts: [{ type: "text", text }],
});
const assistant = (id, tools = []) => ({
  info: { id, role: "assistant", time: { created: 2 } },
  parts: tools.map(([tool, input]) => ({
    type: "tool",
    tool,
    state: { status: "completed", input },
  })),
});
const checkpoint = (messageId, toolMessageId) => ({
  checkpointId: `cp_${messageId}_${toolMessageId ?? ""}`,
  messageId,
  targetMessageId: messageId,
  ...(toolMessageId ? { toolMessageId } : {}),
  scope: "workspace",
  snapshotRef: "x",
});

test("buildRewindPoints: real prompts only; edits counted once per checkpoint; shell commands counted", () => {
  const messages = [
    user("u1", "first"),
    assistant("a1", [["Write", { file_path: "a.txt" }]]),
    user("n1", "Workspace rewind applied.", { synthetic: true, source: "rewind" }),
    user("u2", "second"),
    assistant("a2", [
      ["Edit", { file_path: "a.txt" }],
      ["Bash", { command: "npm i" }],
      ["Bash", { command: "ls" }],
    ]),
    user("u3", "third"),
    assistant("a3"),
  ];
  const points = buildRewindPoints(messages, [checkpoint("a1", "t1"), checkpoint("a2", "t2")]);
  assert.equal(points.length, 3, "the synthetic notice is not a turn");
  assert.deepEqual(
    points.map((p) => [p.turn, p.messageId, p.editCount, p.shellCommandCount]),
    [
      [1, "u1", 1, 0],
      [2, "u2", 1, 2],
      [3, "u3", 0, 0],
    ],
  );
  assert.deepEqual(points[1].editedFiles, ["a.txt"]);
  assert.equal(points[0].editCountFromHere, 2);
  assert.equal(points[0].shellCommandCountFromHere, 2);
  assert.equal(points[2].editCountFromHere, 0);
  assert.equal(resolveRewindPoint(points, "#2")?.messageId, "u2");
  assert.equal(resolveRewindPoint(points, "u3")?.turn, 3);
  assert.equal(resolveRewindPoint(points, "7"), undefined);

  const list = formatRewindPointList(points);
  assert.ok(list.indexOf("#3") < list.indexOf("#1"), "newest first");
  assert.match(list, /#2 {2}"second" · 1 edit \(a\.txt\) · 2 shell commands/);
  assert.ok(list.includes(SHELL_SIDE_EFFECTS_NOTE));
  assert.match(formatRewindPointList([]), /no user turns/);
});

test("isPathAllowedByConfinement: everything when off; only workspace (symlinks resolved) when on", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-rewind-confine-"));
  const ws = path.join(base, "ws");
  fs.mkdirSync(ws);
  fs.symlinkSync(base, path.join(ws, "up"));
  const on = { ZCODE_CONFINE_TO_CWD: "1" };
  assert.equal(isPathAllowedByConfinement(path.join(base, "x"), ws, {}), true);
  assert.equal(isPathAllowedByConfinement(path.join(ws, "a/b.txt"), ws, on), true);
  assert.equal(isPathAllowedByConfinement(path.join(base, "x"), ws, on), false);
  assert.equal(isPathAllowedByConfinement(path.join(ws, "up", "x"), ws, on), false);
  fs.rmSync(base, { recursive: true, force: true });
});
