// Sando per-model compaction headroom, end to end (SANDO-COMPACT-HEADROOM.md, SAN-4472): the built CLI headless in yolo
// mode against the scripted local OpenAI-compatible server (no GPU, no network). The "model" runs six Bash commands of
// ~12k chars each (~18k tokens in all) on a 32k window: upstream compacts past ~11.6k tokens, Sando only past ~21.6k.
// The pruner is off in every run so only the compaction trigger differs.
// Run: pnpm -r --filter "@zcode/cli..." run build && node --test test/sando-compact-headroom.e2e.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const CLI = new URL("../dist/zcode.cjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-headroom-e2e-"));
const home = path.join(base, "home");
const ws = path.join(base, "ws");
const COMPACT_MARKER = "Respond with TEXT ONLY";
let fake;

const midLog = (k) =>
  `for i in $(seq 1 400); do echo "[step${k}] check $i ... ok"; done; echo "error: E_STEP${k}_END"`;

function writeProviderConfig(contextWindow) {
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
                api: {
                  type: "openai-chat-completions",
                  baseUrl: `http://127.0.0.1:${fake.port}/v1`,
                },
                personalModelIds: ["model-a"],
                modelOrder: ["model-a"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [],
          manualProviderModelRules: [
            {
              providerId: "fake-a",
              modelId: "model-a",
              config: {
                enabled: true,
                properties: {
                  contextWindow,
                  supportsJsonSchemaOutput: false,
                  supportsNativeWebSearch: false,
                  supportsMidConversationSystem: false,
                  inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
                },
                optionSpecs: {
                  reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
                  maxOutputTokens: { max: 8192 },
                },
              },
            },
          ],
        },
        defaultModelSelection: { providerId: "fake-a", modelId: "model-a" },
      },
    }),
  );
}

before(async () => {
  fake = await startFakeOpenAI();
  fake.state.realisticUsage = true;
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# tiny workspace\n");
});

after(async () => {
  await fake?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

const lastText = (msgs) => {
  const m = msgs.at(-1);
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
};

/** Async on purpose: the fake server lives in this process, so a sync spawn would starve it. */
async function sando(steps, extraEnv = {}) {
  fake.state.requests.length = 0;
  // Counted here, not from the messages: after a compaction the old tool results are gone from the request.
  let issued = 0;
  fake.state.scenario = ({ msgs }) => {
    if (lastText(msgs).includes(COMPACT_MARKER)) return null;
    if (issued >= steps.length) return null;
    issued += 1;
    return { name: "Bash", args: { command: steps[issued - 1], description: `step ${issued}` } };
  };
  const env = {
    ...process.env,
    HOME: home,
    SANDO_PROMPT_PROFILE: "lean",
    SANDO_TOOL_RESULT_PRUNER: "off",
    ...extraEnv,
  };
  for (const k of ["ZCODE_MODEL", "ZCODE_HARNESS_DIR", "ZCODE_MAX_TURNS", "ZCODE_CONFINE_TO_CWD"])
    delete env[k];
  if (!("SANDO_COMPACT_HEADROOM" in extraEnv)) delete env.SANDO_COMPACT_HEADROOM;
  const child = spawn(process.execPath, [CLI, "-p", "run the steps", "--mode", "yolo", "--json"], {
    cwd: ws,
    env,
    timeout: 120_000,
  });
  let stderr = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (c) => (stderr += c));
  const status = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
  const requests = [...fake.state.requests];
  const compactions = requests.filter((q) => lastText(q.rawMessages).includes(COMPACT_MARKER)).length;
  return { status, stderr, requests, compactions };
}

const STEPS = [1, 2, 3, 4, 5, 6].map(midLog);

test("32k window, ~18k tokens of tool output: upstream compacts, Sando's per-model headroom does not", async () => {
  writeProviderConfig(32768);
  const upstream = await sando(STEPS, { SANDO_COMPACT_HEADROOM: "upstream" });
  assert.equal(upstream.status, 0, upstream.stderr);
  assert.ok(upstream.compactions >= 1, `upstream compacted ${upstream.compactions} times`);

  const sandoRun = await sando(STEPS);
  assert.equal(sandoRun.status, 0, sandoRun.stderr);
  assert.equal(sandoRun.compactions, 0, "no compaction below 21.6k tokens");
  const tools = sandoRun.requests.at(-1).rawMessages.filter((m) => m.role === "tool");
  assert.equal(tools.length, 6, "all six results still in the final request");
});

test("Sando still compacts on a 32k window once the conversation passes its threshold", async () => {
  writeProviderConfig(32768);
  const r = await sando([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(midLog));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.compactions >= 1, `compacted ${r.compactions} times`);
});

test("SANDO_COMPACT_HEADROOM with an unknown value fails at startup, before any model request", async () => {
  writeProviderConfig(32768);
  const r = await sando([midLog(1)], { SANDO_COMPACT_HEADROOM: "huge" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SANDO_COMPACT_HEADROOM expects auto or upstream/);
  assert.equal(r.requests.length, 0);
});
