// Sando: the TUI /rewind picker — turn list, then files / conversation / both — through the real command center
// with a stand-in app. Run: pnpm exec tsx --test test/sando-rewind-picker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommandCenter } from "../src/command-center/create.ts";

const points = [
  {
    turn: 1,
    messageId: "msg_1",
    preview: "write the notes",
    createdAt: 1_760_000_000_000,
    editCount: 1,
    editedFiles: ["notes.txt"],
    shellCommandCount: 0,
    editCountFromHere: 3,
    shellCommandCountFromHere: 1,
  },
  {
    turn: 2,
    messageId: "msg_2",
    preview: "install deps and edit",
    createdAt: 1_760_000_100_000,
    editCount: 2,
    editedFiles: ["a.ts", "b.ts"],
    shellCommandCount: 1,
    editCountFromHere: 2,
    shellCommandCountFromHere: 1,
  },
];

function center() {
  const submitted = [];
  const app = {
    listRewindPoints: async () => points,
    listCheckpoints: async () => [],
    submitPrompt: async (prompt) => {
      submitted.push(prompt);
      return { response: `ran ${prompt}` };
    },
  };
  const submit = createCommandCenter({
    getApp: async () => app,
    resumeApp: async () => app,
  });
  return { submit, submitted };
}

test("/rewind opens a turn picker, newest first, with edits and shell commands", async () => {
  const { submit, submitted } = center();
  const r = await submit("/rewind");
  assert.equal(submitted.length, 0, "the picker is local; nothing is run yet");
  assert.equal(r.selection.title, "Rewind");
  assert.deepEqual(
    r.selection.items.map((item) => item.command),
    ["/rewind pick 2", "/rewind pick 1"],
  );
  assert.match(r.selection.items[0].primary, /#2 {2}install deps and edit/);
  assert.match(r.selection.items[0].meta, /2 edits \| 1 shell command/);
  assert.equal(r.selection.items[0].secondary, "a.ts, b.ts");
});

test("picking a turn asks what to restore and warns about shell commands", async () => {
  const { submit } = center();
  const r = await submit("/rewind pick 1");
  assert.deepEqual(
    r.selection.items.map((item) => [item.primary, item.command]),
    [
      ["Files and conversation", "/rewind to 1 both"],
      ["Conversation only", "/rewind to 1 conversation"],
      ["Files only", "/rewind to 1 files"],
    ],
  );
  assert.match(r.selection.items[0].meta, /undo 3 file edits from turn 1 on/);
  assert.match(r.selection.prompt, /1 shell command ran since\. Shell commands are not undone/);
});

test("the chosen scope runs as a normal /rewind command in the runtime", async () => {
  const { submit, submitted } = center();
  const r = await submit("/rewind to 2 files");
  assert.deepEqual(submitted, ["/rewind to 2 files"]);
  assert.equal(r.response, "ran /rewind to 2 files");
});
