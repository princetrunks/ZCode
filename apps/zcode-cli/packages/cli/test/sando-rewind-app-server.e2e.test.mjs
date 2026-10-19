// Sando: the web workbench's rewind seam end to end — the built `sando app-server --stdio` (dist/zcode.cjs) driven
// over its NDJSON JSON-RPC pipe exactly as the desktop/web host does (packages/services zcodeAgentService.ts):
// v4/conversation/subscribe (cold resume of a session made by headless runs) → v4/command listRewindPoints /
// rewindToTurn / undoRewind. Besides the command ACKs and the files on disk, it checks the conversation the
// subscriber would render: snapshot + delta frames applied with the shared reducer (applyConversationDeltas), plus
// v4/conversation/rowsRange as the stateless read of the same projection.
// Same throwaway HOME + scripted fake model as sando-rewind.e2e.test.mjs. No GPU, no network beyond loopback.
// Run: mise exec -- pnpm exec tsx --test apps/zcode-cli/packages/cli/test/sando-rewind-app-server.e2e.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai-server.mjs";
import { applyConversationDeltas } from "../../../../../packages/shared/src/zcode-protocol-v4/apply.ts";

const CLI = new URL("../dist/zcode.cjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-rewind-app-server-"));
const home = path.join(base, "home");
const ws = path.join(base, "ws");
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

const step = (marker, call) => `${marker} DO ${Buffer.from(JSON.stringify(call)).toString("base64")} END`;
const write = (file_path, content) => ({ name: "Write", args: { file_path, content } });
const read = (file) => {
  const full = path.join(ws, file);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
};

function cleanEnv() {
  const env = { ...process.env, HOME: home };
  for (const k of ["ZCODE_MODEL", "ZCODE_HARNESS_DIR", "ZCODE_MAX_TURNS", "ZCODE_CONFINE_TO_CWD"]) delete env[k];
  return env;
}

before(async () => {
  fake = await startFakeOpenAI();
  fake.state.scenario = scripted;
  fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# tiny workspace\n");
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

let server;
after(async () => {
  await server?.close();
  await fake?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

/** One headless turn of the session (`-p ... --json [--resume]`), like the CLI e2e test. */
async function headlessTurn(prompt, sessionId) {
  const args = ["-p", prompt, "--mode", "yolo", "--json", ...(sessionId ? ["--resume", sessionId] : [])];
  const child = spawn(process.execPath, [CLI, ...args], { cwd: ws, env: cleanEnv(), timeout: 90_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const status = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(status, 0, `sando exited ${status}: ${stderr.slice(0, 2000)}`);
  return JSON.parse(stdout).sessionId;
}

/**
 * The app-server child plus a minimal host: JSON-RPC requests by id, and a subscriber that keeps the conversation
 * snapshot current from `v4/conversation/frame` notifications (complete or fragmented physical frames).
 */
function startAppServer() {
  const child = spawn(process.execPath, [CLI, "app-server", "--stdio"], { cwd: ws, env: cleanEnv() });
  let nextId = 1;
  const pending = new Map();
  const fragments = new Map();
  const frames = [];
  const unexpectedServerRequests = [];
  let snapshot = null;
  let frameWaiters = [];
  let stderr = "";
  let buffer = "";
  child.stderr.on("data", (c) => (stderr += c));

  function onFrame(frame) {
    frames.push(frame);
    if (frame.payload.kind === "snapshot") snapshot = frame.payload.snapshot;
    else if (snapshot) snapshot = applyConversationDeltas(snapshot, frame.payload.deltas);
    const waiters = frameWaiters;
    frameWaiters = [];
    for (const w of waiters) w();
  }

  function onWire(wire) {
    if (wire.kind === "complete") return onFrame(wire.frame);
    const parts = fragments.get(wire.logicalFrameId) ?? [];
    parts[wire.fragmentIndex] = Buffer.from(wire.dataBase64, "base64");
    fragments.set(wire.logicalFrameId, parts);
    if (parts.filter(Boolean).length === wire.fragmentCount) {
      fragments.delete(wire.logicalFrameId);
      onFrame(JSON.parse(Buffer.concat(parts).toString("utf8")));
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method === "v4/conversation/frame") {
        onWire(msg.params);
      } else if (msg.method && msg.id !== undefined) {
        // Server → host requests. Resuming a session asks the host for its runtime preferences (the desktop host
        // answers from settings); answer with defaults. Anything else is unexpected here: refuse so nothing hangs.
        const reply =
          msg.method === "session/requestRuntimePreferences"
            ? { id: msg.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false } }
            : { id: msg.id, error: { code: -32601, message: `test host does not handle ${msg.method}` } };
        if (!reply.result) unexpectedServerRequests.push(msg.method);
        child.stdin.write(`${JSON.stringify(reply)}\n`);
      }
    }
  });

  function request(method, params, timeoutMs = 60_000) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${stderr.slice(-2000)}`)), timeoutMs);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  /** Wait until `predicate(snapshot)` holds (re-checked on every frame), or fail after `timeoutMs`. */
  async function waitForSnapshot(predicate, label, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(snapshot && predicate(snapshot))) {
      const left = deadline - Date.now();
      if (left <= 0) {
        const kinds = frames.map((f) => `${f.payload.kind}(${f.fromSeq}->${f.toSeq})`).join(" ");
        assert.fail(`timed out waiting for ${label}; frames seen: ${kinds}; markers now: ${markers(snapshot)}`);
      }
      await new Promise((resolve) => {
        frameWaiters.push(resolve);
        setTimeout(resolve, Math.min(left, 250));
      });
    }
    return snapshot;
  }

  return {
    request,
    waitForSnapshot,
    frames,
    unexpectedServerRequests,
    get snapshot() {
      return snapshot;
    },
    /** Stop the child (only this PID) and wait for it to exit, so its files are closed before cleanup. */
    close: () =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => {
            child.once("exit", resolve);
            child.kill();
          }),
  };
}

/** The MARK-A* markers of the user rows in a set of conversation rows, in order. */
function userMarkers(rows) {
  return rows
    .filter((row) => row.kind === "userInput")
    .map((row) => JSON.stringify(row).match(/MARK-A\d/)?.[0])
    .filter(Boolean);
}
const markers = (snap) => (snap ? userMarkers(snap.rows.window).join(",") : "(no snapshot)");

/** The host's open: subscribe to conversation/<sid> with the workspace ref (cold resume); frames follow the ACK. */
async function subscribe(srv, sessionId) {
  const sub = await srv.request("v4/conversation/subscribe", {
    topic: `conversation/${sessionId}`,
    connectionId: `conn-${randomUUID()}`,
    clientMode: "desktop-continuous",
    workspace: { workspacePath: ws, workspaceKey: ws },
  });
  assert.ok(sub.ack.subscriptionId, "subscribe ACK carries a subscriptionId");
  return sub.ack;
}

test("app-server: listRewindPoints → rewindToTurn(both) → undoRewind, files and subscriber projection follow", async (t) => {
  // 1. Three turns through headless runs.
  const sessionId = await headlessTurn(step("MARK-A1", write("notes.txt", "v1\n")));
  await headlessTurn(step("MARK-A2", write("notes.txt", "v2\n")), sessionId);
  await headlessTurn(step("MARK-A3", write("extra.txt", "x\n")), sessionId);
  assert.equal(read("notes.txt"), "v2\n");
  assert.equal(read("extra.txt"), "x\n");

  // 2. The host's flow: the app-server child, then a conversation subscribe that cold-resumes the session.
  server = startAppServer();
  const clientId = `client-${randomUUID()}`;
  await subscribe(server, sessionId);
  await server.waitForSnapshot((s) => markers(s) === "MARK-A1,MARK-A2,MARK-A3", "initial snapshot with 3 turns");

  const command = async (type, payload) => {
    const ack = await server.request("v4/command", {
      commandId: randomUUID(),
      clientId,
      sessionId,
      type,
      payload,
      issuedAt: Date.now(),
    });
    assert.equal(ack.status, "accepted", `${type} ACK: ${JSON.stringify(ack)}`);
    assert.equal(ack.result?.type, type);
    return ack.result;
  };
  /** Stateless page read of the same projection (what a reloading web client would fetch). */
  const rowsRangeMarkers = async (srv = server) =>
    userMarkers((await srv.request("v4/conversation/rowsRange", { sessionId, limit: 200 })).rows).join(",");
  assert.equal(await rowsRangeMarkers(), "MARK-A1,MARK-A2,MARK-A3");

  // 3. listRewindPoints: three turns, with edit counts.
  const list = await command("listRewindPoints", {});
  assert.equal(list.points.length, 3, JSON.stringify(list.points));
  assert.deepEqual(
    list.points.map((p) => p.turn),
    [1, 2, 3],
  );
  const turn2 = list.points.find((p) => p.turn === 2);
  assert.match(turn2.preview, /MARK-A2/);
  assert.equal(turn2.editCount, 1);
  assert.deepEqual(turn2.editedFiles.map((f) => path.basename(f)), ["notes.txt"]);
  assert.equal(turn2.editCountFromHere, 2);
  assert.equal(list.undo, null, "nothing to undo yet");

  // 4. rewindToTurn(turn 2, both): files back to before turn 2, turns 2–3 gone from what the subscriber sees.
  const rewound = await command("rewindToTurn", { targetMessageId: turn2.messageId, scope: "both" });
  assert.equal(rewound.applied, true, rewound.response);
  assert.equal(rewound.conversationRewound, true);
  assert.equal(rewound.turn, 2);
  assert.match(rewound.response, /Rewound to before turn 2/);
  assert.equal(rewound.restoredFiles.length, 2, JSON.stringify(rewound.restoredFiles));
  assert.equal(read("notes.txt"), "v1\n");
  assert.equal(read("extra.txt"), null);
  assert.ok(rewound.undo, "the rewind is undoable");
  assert.equal(rewound.undo.kind, "rewind");
  await server.waitForSnapshot((s) => markers(s) === "MARK-A1", "subscriber projection without turns 2–3");
  assert.equal(await rowsRangeMarkers(), "MARK-A1");
  assert.equal((await command("listRewindPoints", {})).points.length, 1);

  // 5. undoRewind: files and turns 2–3 come back, and the subscriber's projection shows them again.
  const undone = await command("undoRewind", {});
  assert.equal(undone.applied, true, undone.response);
  assert.equal(undone.conversationRewound, true);
  assert.match(undone.response, /Undid rewind to before turn 2/);
  assert.equal(read("notes.txt"), "v2\n");
  assert.equal(read("extra.txt"), "x\n");
  assert.equal(undone.undo?.kind, "undo", "the undo is itself undoable");
  assert.equal((await command("listRewindPoints", {})).points.length, 3, "the runtime has turns 2–3 back");

  // undoRewind calls rebuildConversationProjection; the rebuild must not replay the earlier rewind's in-memory
  // RewindTriggered (cold-event-merge.ts drops cuts from older branch generations), or turns 2–3 vanish again.
  await t.test(
    "subscriber projection (and rowsRange) show turns 2–3 again after undoRewind",
    async () => {
      await server.waitForSnapshot(
        (s) => markers(s) === "MARK-A1,MARK-A2,MARK-A3",
        "subscriber projection with turns 2–3 restored (snapshot pushed by rebuildConversationProjection)",
        5_000,
      );
      assert.equal(await rowsRangeMarkers(), "MARK-A1,MARK-A2,MARK-A3");
    },
  );

  // Control: a host that opens the session from scratch (new app-server process) sees all three turns, so the
  // persisted conversation is right; only the live process's rebuilt projection is stale.
  await server.close();
  server = startAppServer();
  await subscribe(server, sessionId);
  await server.waitForSnapshot((s) => markers(s) === "MARK-A1,MARK-A2,MARK-A3", "fresh process: 3 turns");
  assert.equal(await rowsRangeMarkers(), "MARK-A1,MARK-A2,MARK-A3");
  assert.deepEqual(server.unexpectedServerRequests, [], "the app-server asked the host nothing unexpected");
});
