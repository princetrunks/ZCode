// Sando reasoning profiles end to end: the built CLI (dist/zcode.cjs) against the scripted local OpenAI server,
// two user turns (the second through --resume), the model streaming `reasoning_content` on every step.
// Checks which `reasoning_content` goes back on the wire per model id:
//   bonsai2-27b (forge, no profile)   -> passthrough: everything, as before profiles existed
//   deepseek-v4-flash                 -> keep-all-with-tools: everything while tools are declared; a request
//                                        without tools (--max-turns 1) drops earlier turns' thinking
//   MiniMax-M3.1-Flash                -> keep-all: every turn's reasoning, unchanged
// Run: pnpm -r --filter "@zcode/cli..." run build && pnpm test (cli package). No GPU, no network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const CLI = new URL("../dist/zcode.cjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-reasoning-e2e-"));
const home = path.join(base, "home");
const ws = path.join(base, "ws");
let fake;

const MODELS = [
  ["fake-forge", "bonsai2-27b"],
  ["fake-ds", "deepseek-v4-flash"],
  ["fake-mm", "MiniMax-M3.1-Flash"],
];

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

before(async () => {
  fake = await startFakeOpenAI();
  const rule = (providerId, modelId) => ({
    providerId,
    enabled: true,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "fake" },
      api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${fake.port}/v1` },
      personalModelIds: [modelId],
      modelOrder: [modelId],
    },
  });
  fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".zcode", "v2", "provider_config.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerOrder: MODELS.map(([p]) => p),
        providerConfigRules: { providerRules: MODELS.map(([p, m]) => rule(p, m)) },
        modelConfigRules: {
          providerModelRules: [],
          manualProviderModelRules: MODELS.map(([providerId, modelId]) => ({
            providerId,
            modelId,
            config: modelConfig,
          })),
        },
        defaultModelSelection: { providerId: MODELS[0][0], modelId: MODELS[0][1] },
      },
    }),
  );
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# tiny workspace\n");
  // Each user turn: step 1 thinks "<TURN>-plan" and reads README.md; step 2 thinks "<TURN>-final" and answers.
  fake.state.handler = ({ msgs, tools }) => {
    const turn = [...msgs]
      .reverse()
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
      .find((c) => /TURN[12]/.test(c))
      ?.match(/TURN[12]/)?.[0];
    const last = msgs.at(-1);
    const afterTool = last?.role === "tool";
    if (!afterTool && tools.includes("Read")) {
      return { reasoning: `${turn}-plan`, calls: [{ name: "Read", args: { file_path: "README.md" } }] };
    }
    return { reasoning: `${turn}-final`, text: `done ${turn}` };
  };
});

after(async () => {
  await fake?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

async function sando(env, ...args) {
  fake.state.requests.length = 0;
  const childEnv = { ...process.env, HOME: home, ...env };
  for (const k of ["ZCODE_MODEL", "ZCODE_HARNESS_DIR", "ZCODE_MAX_TURNS", "ZCODE_CONFINE_TO_CWD"])
    delete childEnv[k];
  if (!env.SANDO_REASONING_HISTORY) delete childEnv.SANDO_REASONING_HISTORY;
  const child = spawn(process.execPath, [CLI, ...args], { cwd: ws, env: childEnv, timeout: 90_000 });
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
  return { status, stderr, json, requests: [...fake.state.requests] };
}

/** reasoning_content of every assistant message in one request, in order ("" when absent). */
const replayed = (request) =>
  request.rawMessages.filter((m) => m.role === "assistant").map((m) => m.reasoning_content ?? "");

async function twoTurns(provider, model, env = {}) {
  const sel = `${provider}/${model}`;
  const t1 = await sando(env, "-p", "TURN1 read the readme", "--model", sel, "--json");
  assert.equal(t1.status, 0, t1.stderr.slice(-2000));
  assert.equal(t1.requests.length, 2, "turn 1: tool step + answer step");
  const t2 = await sando(env, "--resume", t1.json.sessionId, "-p", "TURN2 again", "--model", sel, "--json");
  assert.equal(t2.status, 0, t2.stderr.slice(-2000));
  assert.equal(t2.requests.length, 2, "turn 2: tool step + answer step");
  assert.equal(t2.json.response.trim(), "done TURN2");
  return { t1, t2 };
}

test("forge model without a profile: passthrough replays every reasoning block (unchanged behaviour)", async () => {
  const { t1, t2 } = await twoTurns(...MODELS[0]);
  assert.deepEqual(replayed(t1.requests[1]), ["TURN1-plan"]);
  assert.deepEqual(replayed(t2.requests[1]), ["TURN1-plan", "TURN1-final", "TURN2-plan"]);
});

test("deepseek-v4-flash: tools declared -> every turn's reasoning goes back (DeepSeek encoder)", async () => {
  const { t2 } = await twoTurns(...MODELS[1]);
  assert.deepEqual(replayed(t2.requests[1]), ["TURN1-plan", "TURN1-final", "TURN2-plan"]);
});

test("deepseek-v4-flash: a request without tools drops thinking from before the last user message", async () => {
  const sel = `${MODELS[1][0]}/${MODELS[1][1]}`;
  const t1 = await sando({}, "-p", "TURN1 read the readme", "--model", sel, "--json");
  assert.equal(t1.status, 0, t1.stderr.slice(-2000));
  const t2 = await sando({}, "--resume", t1.json.sessionId, "-p", "TURN2 answer", "--model", sel, "--max-turns", "1", "--json");
  assert.equal(t2.status, 0, t2.stderr.slice(-2000));
  assert.equal(t2.requests.length, 1);
  assert.equal(t2.requests[0].toolCount, 0);
  assert.deepEqual(replayed(t2.requests[0]), ["", ""]);
  // the forge model under the same conditions keeps everything (passthrough)
  const f = `${MODELS[0][0]}/${MODELS[0][1]}`;
  const f1 = await sando({}, "-p", "TURN1 read the readme", "--model", f, "--json");
  const f2 = await sando({}, "--resume", f1.json.sessionId, "-p", "TURN2 answer", "--model", f, "--max-turns", "1", "--json");
  assert.deepEqual(replayed(f2.requests[0]), ["TURN1-plan", "TURN1-final"]);
});

test("MiniMax-M3.1-Flash: keep-all replays every turn's reasoning", async () => {
  const { t2 } = await twoTurns(...MODELS[2]);
  assert.deepEqual(replayed(t2.requests[1]), ["TURN1-plan", "TURN1-final", "TURN2-plan"]);
});

test("SANDO_REASONING_HISTORY=strip overrides the table, even for MiniMax", async () => {
  const { t2 } = await twoTurns(...MODELS[2], { SANDO_REASONING_HISTORY: "strip" });
  assert.deepEqual(replayed(t2.requests[1]), ["", "", ""]);
});
