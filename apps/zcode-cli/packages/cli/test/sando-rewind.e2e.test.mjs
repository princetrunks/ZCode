// Sando: checkpoints + /rewind end to end through the built CLI (dist/zcode.cjs) against the scripted local
// OpenAI-compatible server, with a throwaway HOME and one workspace per test. No GPU, no network.
// Each headless run is one turn of the same session (`--resume`). The scripted model performs the tool call encoded
// in the prompt (`DO <base64 json> END`), then answers. The transcript check is what the model is sent next: after a
// rewind the next request must carry the kept turns' markers and none of the rewound ones.
// Run: pnpm -r --filter "@zcode/cli..." run build && node --test test/sando-rewind.e2e.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const CLI = new URL("../dist/zcode.cjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-rewind-e2e-"));
const home = path.join(base, "home");
let fake;

const modelConfig = {
  enabled: true,
  properties: {
    contextWindow: 131072,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
    inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
  },
  optionSpecs: {
    reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
    maxOutputTokens: { max: 8192 },
  },
};

const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
const DIRECTIVE = /DO ([A-Za-z0-9+/=]+) END/;

/** Do the tool call named by the newest user directive, once; then answer in text. */
function scripted({ msgs }) {
  let lastDirective = -1;
  let lastTool = -1;
  msgs.forEach((m, i) => {
    if (m.role === "user" && DIRECTIVE.test(text(m))) lastDirective = i;
    if (m.role === "tool") lastTool = i;
  });
  if (lastDirective < 0 || lastTool > lastDirective) return null;
  const encoded = text(msgs[lastDirective]).match(DIRECTIVE)[1];
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

const step = (marker, call) =>
  `${marker} ${call ? `DO ${Buffer.from(JSON.stringify(call)).toString("base64")} END` : ""}`.trim();
const write = (file_path, content) => ({ name: "Write", args: { file_path, content } });
const bash = (command) => ({ name: "Bash", args: { command, description: "test step" } });

before(async () => {
  fake = await startFakeOpenAI();
  fake.state.scenario = scripted;
  fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".zcode", "v2", "provider_config.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerOrder: ["fake-a"],
        providerConfigRules: {
          providerRules: [
            {
              providerId: "fake-a",
              enabled: true,
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "fake" },
                api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${fake.port}/v1` },
                personalModelIds: ["model-a"],
                modelOrder: ["model-a"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [],
          manualProviderModelRules: [{ providerId: "fake-a", modelId: "model-a", config: modelConfig }],
        },
        defaultModelSelection: { providerId: "fake-a", modelId: "model-a" },
      },
    }),
  );
});

after(async () => {
  await fake?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

/** A fresh workspace with its own session. `turn(prompt, ...flags)` runs one headless turn of that session. */
function workspace(name) {
  const ws = path.join(base, name);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# tiny workspace\n");
  let sessionId;
  async function turn(prompt, { env: extraEnv = {}, flags = [] } = {}) {
    fake.state.requests.length = 0;
    const env = { ...process.env, HOME: home, ...extraEnv };
    for (const k of ["ZCODE_MODEL", "ZCODE_HARNESS_DIR", "ZCODE_MAX_TURNS", "ZCODE_CONFINE_TO_CWD"]) {
      if (!(k in extraEnv)) delete env[k];
    }
    const args = ["-p", prompt, "--mode", "yolo", "--json", ...flags];
    if (sessionId) args.push("--resume", sessionId);
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ws, env, timeout: 90_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const status = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
    let json = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
    assert.equal(status, 0, `sando exited ${status}: ${stderr.slice(0, 2000)}`);
    sessionId ??= json?.sessionId;
    return { json, response: json?.response ?? "", requests: [...fake.state.requests] };
  }
  const read = (file) => {
    const full = path.isAbsolute(file) ? file : path.join(ws, file);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  };
  /** Everything the model is sent on the next turn (all messages of its first request). */
  async function nextRequestText(marker) {
    const r = await turn(marker);
    return r.requests[0]?.all ?? "";
  }
  return { ws, turn, read, nextRequestText };
}

test("edit → edit → /rewind to 2: files and transcript match turn 2's start; undo and redo", async () => {
  const w = workspace("both");
  await w.turn(step("MARK-T1", write("notes.txt", "v1\n")));
  await w.turn(step("MARK-T2", write("notes.txt", "v2\n")));
  await w.turn(step("MARK-T3", write("extra.txt", "made in turn 3\n")));
  assert.equal(w.read("notes.txt"), "v2\n");
  assert.equal(w.read("extra.txt"), "made in turn 3\n");

  const list = await w.turn("/rewind list");
  assert.match(list.response, /#3 .*MARK-T3.*1 edit \(extra\.txt\)/);
  assert.match(list.response, /#2 .*MARK-T2.*1 edit \(notes\.txt\)/);
  assert.match(list.response, /#1 .*MARK-T1.*1 edit \(notes\.txt\)/);
  assert.equal(list.requests.length, 0, "/rewind never calls the model");

  const rewound = await w.turn("/rewind to 2");
  assert.match(rewound.response, /Rewound to before turn 2/);
  assert.match(rewound.response, /restored 2 files/);
  assert.match(rewound.response, /Undo with \/rewind undo/);
  assert.equal(w.read("notes.txt"), "v1\n", "notes.txt is back to its turn-1 content");
  assert.equal(w.read("extra.txt"), null, "extra.txt did not exist before turn 2");

  const afterRewind = await w.nextRequestText("MARK-T4");
  assert.match(afterRewind, /MARK-T1/);
  assert.doesNotMatch(afterRewind, /MARK-T2|MARK-T3/, "rewound turns are not sent to the model");

  const undone = await w.turn("/rewind undo");
  assert.match(undone.response, /Undid rewind to before turn 2/);
  assert.match(undone.response, /Conversation: restored/);
  assert.equal(w.read("notes.txt"), "v2\n");
  assert.equal(w.read("extra.txt"), "made in turn 3\n");
  const afterUndo = await w.nextRequestText("MARK-T5");
  assert.match(afterUndo, /MARK-T1[\s\S]*MARK-T2[\s\S]*MARK-T3/, "turns 2 and 3 are back, in order");
  assert.doesNotMatch(afterUndo, /MARK-T4/, "the turn made on the rewound branch is not in the restored one");

  // The undo was itself undoable: undo it (redo the rewind). T5 was added after the undo, so it is cut too.
  const redone = await w.turn("/rewind undo");
  assert.match(redone.response, /Undid undo of rewind to before turn 2/);
  assert.equal(w.read("notes.txt"), "v1\n");
  assert.equal(w.read("extra.txt"), null);
  const afterRedo = await w.nextRequestText("MARK-T6");
  assert.match(afterRedo, /MARK-T1/);
  assert.match(afterRedo, /MARK-T4/, "the rewound branch, including its own turn, is active again");
  assert.doesNotMatch(afterRedo, /MARK-T2|MARK-T3|MARK-T5/);
});

test("/rewind to N files: files restored, conversation kept, the model is told", async () => {
  const w = workspace("files-only");
  await w.turn(step("MARK-F1", write("a.txt", "one\n")));
  await w.turn(step("MARK-F2", write("a.txt", "two\n")));
  const r = await w.turn("/rewind to 2 files");
  assert.match(r.response, /Conversation: unchanged \(files only\)/);
  assert.equal(w.read("a.txt"), "one\n");
  const next = await w.nextRequestText("MARK-F3");
  assert.match(next, /MARK-F1[\s\S]*MARK-F2/, "conversation still has both turns");
  assert.match(next, /Workspace files were restored to their state before turn 2/);
});

test("/rewind to N conversation: files untouched, later turns gone from the transcript", async () => {
  const w = workspace("conversation-only");
  await w.turn(step("MARK-C1", write("b.txt", "one\n")));
  await w.turn(step("MARK-C2", write("b.txt", "two\n")));
  const r = await w.turn("/rewind to 2 conversation");
  assert.match(r.response, /Files: left as they are/);
  assert.equal(w.read("b.txt"), "two\n");
  const next = await w.nextRequestText("MARK-C3");
  assert.match(next, /MARK-C1/);
  assert.doesNotMatch(next, /MARK-C2/);
});

test("shell commands: listed, warned about, and their effects stay", async () => {
  const w = workspace("bash");
  await w.turn(step("MARK-B1", write("c.txt", "one\n")));
  await w.turn(step("MARK-B2", bash("echo from-bash > made-by-bash.txt")));
  assert.equal(w.read("made-by-bash.txt"), "from-bash\n");
  const list = await w.turn("/rewind list");
  assert.match(list.response, /#2 .*MARK-B2.*1 shell command/);
  assert.match(list.response, /Shell commands are not undone/);
  const r = await w.turn("/rewind to 2");
  assert.match(r.response, /1 shell command ran in the rewound turns\. Shell commands are not undone/);
  assert.equal(w.read("made-by-bash.txt"), "from-bash\n", "a shell command's file is not removed");
});

test("a file changed outside the agent blocks the rewind; force overwrites it and undo brings the change back", async () => {
  const w = workspace("external");
  await w.turn(step("MARK-E1", write("d.txt", "agent v1\n")));
  await w.turn(step("MARK-E2", write("d.txt", "agent v2\n")));
  fs.writeFileSync(path.join(w.ws, "d.txt"), "edited by hand\n");
  const blocked = await w.turn("/rewind to 2");
  assert.match(blocked.response, /was not applied; nothing was changed/);
  assert.match(blocked.response, /d\.txt: changed outside the agent/);
  assert.equal(w.read("d.txt"), "edited by hand\n");
  const forced = await w.turn("/rewind to 2 force");
  assert.match(forced.response, /Rewound to before turn 2/);
  assert.equal(w.read("d.txt"), "agent v1\n");
  await w.turn("/rewind undo");
  assert.equal(w.read("d.txt"), "edited by hand\n", "undo restores the hand edit the forced rewind overwrote");
});

test("size cap: an oversized file is checkpointed without content and left alone by rewind", async () => {
  const w = workspace("size-cap");
  const env = { SANDO_CHECKPOINT_MAX_FILE_BYTES: "64" };
  await w.turn(step("MARK-S1", write("small.txt", "small v1\n")), { env });
  await w.turn(step("MARK-S2", write("small.txt", "small v2\n")), { env });
  await w.turn(step("MARK-S2b", write("big.txt", `${"x".repeat(200)}\n`)), { env });
  const r = await w.turn("/rewind to 2 files", { env });
  assert.match(r.response, /big\.txt: too large to checkpoint/);
  assert.equal(w.read("small.txt"), "small v1\n");
  assert.equal(w.read("big.txt"), `${"x".repeat(200)}\n`, "the oversized file is not deleted or truncated");
});

test("session budget: oldest checkpoints are pruned; rewinding past them is refused, force skips them", async () => {
  const w = workspace("prune");
  // One small Write checkpoint artifact is ~0.5 KB; this budget keeps about two.
  const env = { SANDO_CHECKPOINT_SESSION_BUDGET_BYTES: "1200" };
  await w.turn(step("MARK-P1", write("p.txt", "p1\n")), { env });
  await w.turn(step("MARK-P2", write("q.txt", "q1\n")), { env });
  await w.turn(step("MARK-P3", write("p.txt", "p2\n")), { env });
  await w.turn(step("MARK-P4", write("q.txt", "q2\n")), { env });
  const refused = await w.turn("/rewind to 1 files", { env });
  assert.match(refused.response, /was not applied; nothing was changed/);
  assert.match(refused.response, /pruned to keep this session within its checkpoint budget/);
  assert.equal(w.read("p.txt"), "p2\n");
  // The newest turns stay restorable.
  const recent = await w.turn("/rewind to 4 files", { env });
  assert.match(recent.response, /Rewound to before turn 4/);
  assert.equal(w.read("q.txt"), "q1\n");
  await w.turn("/rewind undo", { env });
  assert.equal(w.read("q.txt"), "q2\n");
  const forced = await w.turn("/rewind to 1 files force", { env });
  assert.match(forced.response, /checkpoint pruned \(session checkpoint budget\)/);
});

test("--confine-to-cwd: rewind leaves files outside the workspace alone", async () => {
  const w = workspace("confine");
  const outside = path.join(base, "outside-confine.txt");
  await w.turn(step("MARK-O1", write("inside.txt", "in v1\n")));
  await w.turn(step("MARK-O2", write(outside, "outside\n")));
  await w.turn(step("MARK-O3", write("inside.txt", "in v2\n")));
  const r = await w.turn("/rewind to 2 files", { flags: ["--confine-to-cwd"] });
  assert.match(r.response, /outside-confine\.txt: outside the workspace \(--confine-to-cwd\)/);
  assert.equal(w.read("inside.txt"), "in v1\n");
  assert.equal(w.read(outside), "outside\n", "the outside file is not deleted");
});

test("bad /rewind targets answer clearly and change nothing", async () => {
  const w = workspace("bad-target");
  await w.turn(step("MARK-X1", write("e.txt", "one\n")));
  const r = await w.turn("/rewind to 9");
  assert.match(r.response, /There is no turn 9 in this conversation \(turns 1–1\)/);
  const u = await w.turn("/rewind undo");
  assert.match(u.response, /Nothing to undo/);
  assert.equal(w.read("e.txt"), "one\n");
});
