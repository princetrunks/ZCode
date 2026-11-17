// Sando spill head + tail and the tool-result pruner, end to end: the built CLI (dist/zcode.cjs) headless in yolo mode
// against a scripted local OpenAI-compatible server (no GPU, no network). The "model" runs Bash commands whose output
// ends in an error line; the test reads what the next request actually carried.
// Run: pnpm -r --filter "@zcode/cli..." run build && node --test test/sando-spill-headtail.e2e.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const CLI = new URL("../dist/zcode.cjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-spill-e2e-"));
const home = path.join(base, "home");
const ws = path.join(base, "ws");
let fake;

// ~60k chars of "ok" lines, then the only line that matters.
const BIG_LOG = `for i in $(seq 1 3000); do echo "[build] compiling unit $i ... ok"; done; echo "error: E_LAST_LINE in src/app.ts:42"; exit 1`;
// ~12k chars each (under Bash's 30 kB spill limit), so they stay inline and only the pruner can shrink them.
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
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# tiny workspace\n");
});

after(async () => {
  await fake?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

/** Async on purpose: the fake server lives in this process, so a sync spawn would starve it. */
async function sando(steps, extraEnv = {}) {
  fake.state.requests.length = 0;
  fake.state.scenario = ({ msgs }) => {
    const done = msgs.filter((m) => m.role === "tool").length;
    return done < steps.length
      ? { name: "Bash", args: { command: steps[done], description: `step ${done + 1}` } }
      : null;
  };
  const env = { ...process.env, HOME: home, SANDO_PROMPT_PROFILE: "lean", ...extraEnv };
  for (const k of ["ZCODE_MODEL", "ZCODE_HARNESS_DIR", "ZCODE_MAX_TURNS", "ZCODE_CONFINE_TO_CWD"])
    delete env[k];
  if (!("SANDO_TOOL_RESULT_PRUNER" in extraEnv)) delete env.SANDO_TOOL_RESULT_PRUNER;
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
  return { status, stderr, requests: [...fake.state.requests] };
}

const toolTexts = (req) =>
  req.rawMessages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

test("spill: a 60k-char Bash log whose error is on the last line shows that line to the model", async () => {
  writeProviderConfig(131072);
  const r = await sando([BIG_LOG]);
  assert.equal(r.status, 0, r.stderr);
  const result = r.requests.at(-1).lastTool;
  assert.match(result, /<persisted-output>/);
  assert.match(result, /Full output saved to: \S+/);
  assert.match(result, /\[build\] compiling unit 1 \.\.\. ok/, "head kept");
  assert.match(result, /\n… [\d.]+KB omitted …\n/);
  assert.match(result, /error: E_LAST_LINE in src\/app\.ts:42/, "the last line reached the model");
  assert.ok(result.length < 4_000, `preview stays small (${result.length})`);
});

test("pruner (32k window): old results are trimmed to head + tail and keep their error line; newest 2 intact", async () => {
  writeProviderConfig(32768);
  const steps = [1, 2, 3, 4, 5].map(midLog);
  // Sized for the upstream 32k trigger (pruner from ~9.6k tokens); Sando's per-model headroom
  // (SANDO-COMPACT-HEADROOM.md) moves it to ~19.4k, so this mechanism test pins the upstream trigger.
  const r = await sando(steps, { SANDO_COMPACT_HEADROOM: "upstream" });
  assert.equal(r.status, 0, r.stderr);
  const last = toolTexts(r.requests.at(-1));
  assert.equal(last.length, 5);
  const pruned = last.filter((t) => /chars pruned from this old tool result/.test(t));
  assert.ok(pruned.length >= 1, "at least one old result was pruned");
  for (const [k, t] of last.entries()) {
    assert.match(t, new RegExp(`E_STEP${k + 1}_END`), `result ${k + 1} keeps its last line`);
    assert.doesNotMatch(t, /Old tool result content cleared/);
  }
  for (const t of last.slice(-2))
    assert.doesNotMatch(t, /chars pruned/, "newest two are untouched");
});

test("SANDO_TOOL_RESULT_PRUNER=off: same run, nothing is pruned (upstream behaviour)", async () => {
  writeProviderConfig(32768);
  const steps = [1, 2, 3, 4, 5].map(midLog);
  const r = await sando(steps, { SANDO_TOOL_RESULT_PRUNER: "off", SANDO_COMPACT_HEADROOM: "upstream" });
  assert.equal(r.status, 0, r.stderr);
  for (const q of r.requests) {
    for (const t of toolTexts(q)) assert.doesNotMatch(t, /chars pruned from this old tool result/);
  }
});

test("SANDO_TOOL_RESULT_PRUNER with an unknown value fails at startup, before any model request", async () => {
  writeProviderConfig(32768);
  const r = await sando([midLog(1)], { SANDO_TOOL_RESULT_PRUNER: "maybe" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SANDO_TOOL_RESULT_PRUNER expects on or off/);
  assert.equal(r.requests.length, 0);
});
