// Sando lean (dsh study 2026-11-17, SAN-4472): an unchanged re-read is served again with a nudge instead of the
// "Wasted call" refusal; the nudge gets firmer at 3 and 5 reads and only the 8th read of one range in a turn is refused.
// The default profile keeps upstream's refusal. Runs the real Read handler from dist on a temp dir.
// Run: pnpm test in apps/zcode-cli/packages/core (tsx --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { readToolEntry, READ_REPEAT_REFUSE_AT } = await import("../dist/tool/handlers/read.js");
const { createNodeFileSystemAdapter } = await import("../../adapters/dist/fs/index.js");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-read-repeat-"));
process.on("exit", () => fs.rmSync(base, { recursive: true, force: true }));
const file = path.join(base, "README.md");
fs.writeFileSync(file, "alpha\nbeta\ngamma\n");

const port = createNodeFileSystemAdapter();

const states = new WeakMap();
const readFileStateOf = (read) => states.get(read);

function session(readRepeatPolicy) {
  const readFileState = new Map();
  let call = 0;
  const read = (input, turnId = "turn-1") =>
    readToolEntry.handler(input, {
      toolCallId: `t${(call += 1)}`,
      workingDirectory: base,
      workspaceRoot: base,
      fileSystemPort: port,
      readFileState,
      abortSignal: new AbortController().signal,
      sessionId: "s1",
      turnId,
      ...(readRepeatPolicy ? { readRepeatPolicy } : {}),
    });
  states.set(read, readFileState);
  return read;
}

const modelText = (output) => readToolEntry.formatModelContent(output);

test("default policy keeps upstream: the 2nd unchanged read is the Wasted call stub", async () => {
  const read = session(undefined);
  assert.equal((await read({ file_path: file })).type, "text");
  const second = await read({ file_path: file });
  assert.equal(second.type, "file_unchanged");
  assert.match(modelText(second), /^Wasted call/);
});

test("nudge: the 2nd read returns the content again with a short note, no refusal", async () => {
  const read = session("nudge");
  await read({ file_path: file });
  const second = await read({ file_path: file });
  assert.equal(second.type, "text");
  const text = modelText(second);
  assert.match(text, /Unchanged since you last read it this turn \(read 2 times\)/);
  assert.match(text, /1\talpha\n2\tbeta\n3\tgamma/);
  assert.doesNotMatch(text, /Wasted call/);
});

test("nudge: firmer note at 3 and 5 reads, refusal only at the loop cap, then it stays refused", async () => {
  const read = session("nudge");
  const texts = [];
  for (let i = 1; i <= READ_REPEAT_REFUSE_AT + 1; i += 1) texts.push(modelText(await read({ file_path: file })));
  assert.equal(READ_REPEAT_REFUSE_AT, 8);
  assert.match(texts[2], /read this unchanged file 3 times this turn\. Work from the content below/);
  assert.match(texts[3], /\(read 4 times\)/);
  assert.match(texts[4], /5 times this turn/);
  for (const i of [1, 2, 3, 4, 5, 6]) assert.match(texts[i], /1\talpha/, `read ${i + 1} carries the content`);
  assert.match(texts[7], /^Refused: this is read 8 of the same unchanged file range this turn/);
  assert.doesNotMatch(texts[7], /alpha/);
  assert.match(texts[8], /^Refused: this is read 9 /);
});

test("nudge: the count is per range and restarts when the file changes or a new turn starts", async () => {
  const read = session("nudge");
  for (let i = 0; i < 4; i += 1) await read({ file_path: file });
  // another range of the same file is its own count
  const ranged = modelText(await read({ file_path: file, offset: 2, limit: 1 }));
  assert.doesNotMatch(ranged, /Unchanged/);
  assert.match(ranged, /^2\tbeta$/);
  // a new turn restarts the count (the 2nd read in it gets the short note)
  assert.match(modelText(await read({ file_path: file }, "turn-2")), /\(read 2 times\)/);
  // a change on disk restarts it too: the next read is a plain first read
  fs.writeFileSync(file, "alpha\nbeta\ngamma\ndelta\n");
  const changed = modelText(await read({ file_path: file }, "turn-2"));
  assert.doesNotMatch(changed, /Unchanged|Refused/);
  assert.match(changed, /4\tdelta/);
  assert.match(modelText(await read({ file_path: file }, "turn-2")), /\(read 2 times\)/);
});

test("nudge: a read after the file state was refreshed by Edit/Write is a first read (content, no note)", async () => {
  const read = session("nudge");
  const edited = path.join(base, "edited.py");
  fs.writeFileSync(edited, "x = 1\n");
  await read({ file_path: edited });
  // what Edit leaves behind: the entry for the whole-file range, rewritten with sourceTool "Edit" and fresh mtime/size
  fs.writeFileSync(edited, "x = 2\n");
  const st = fs.statSync(edited);
  const [key, entry] = [...readFileStateOf(read)].find(([, e]) => e.path === edited);
  readFileStateOf(read).set(key, { ...entry, content: "x = 2\n", sourceTool: "Edit", readCount: undefined, mtimeMs: Math.floor(st.mtimeMs), sizeBytes: st.size, revisionId: undefined });
  const after = modelText(await read({ file_path: edited }));
  assert.match(after, /^1\tx = 2/);
  assert.doesNotMatch(after, /Unchanged|Refused|Wasted/);
  assert.match(modelText(await read({ file_path: edited })), /\(read 2 times\)/);
});
