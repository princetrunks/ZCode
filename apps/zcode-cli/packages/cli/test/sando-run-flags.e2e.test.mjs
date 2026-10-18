// Sando: --model / --harness / --max-turns / --confine-to-cwd, end to end through the built CLI (dist/zcode.cjs)
// against a scripted local OpenAI-compatible server, with a throwaway HOME and workspace. No GPU, no network.
// Run: pnpm -r --filter "@zcode/cli..." run build && node --test test/sando-run-flags.e2e.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const CLI = new URL("../dist/zcode.cjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-flags-e2e-"));
const home = path.join(base, "home");
const ws = path.join(base, "ws");
const harness = path.join(base, "harness");
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
        providerOrder: ["fake-a", "fake-b"],
        providerConfigRules: {
          providerRules: [rule("fake-a", "model-a"), rule("fake-b", "model-b")],
        },
        modelConfigRules: {
          providerModelRules: [],
          manualProviderModelRules: [
            { providerId: "fake-a", modelId: "model-a", config: modelConfig },
            { providerId: "fake-b", modelId: "model-b", config: modelConfig },
          ],
        },
        defaultModelSelection: { providerId: "fake-a", modelId: "model-a" },
      },
    }),
  );
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# tiny workspace\n");
  fs.mkdirSync(path.join(harness, "skills", "harness-hello"), { recursive: true });
  fs.writeFileSync(
    path.join(harness, "AGENTS.md"),
    "HARNESS-MARKER-7731: always answer briefly.\n",
  );
  fs.writeFileSync(
    path.join(harness, "skills", "harness-hello", "SKILL.md"),
    "---\nname: harness-hello\ndescription: HARNESS-SKILL-4410 says hello\n---\nSay hello.\n",
  );
});

after(async () => {
  await fake?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

/** Async on purpose: the fake server lives in this process, so a sync spawn would starve it. */
async function sando(scenario, ...args) {
  fake.state.scenario = scenario;
  fake.state.requests.length = 0;
  const env = { ...process.env, HOME: home };
  for (const k of ["ZCODE_MODEL", "ZCODE_HARNESS_DIR", "ZCODE_MAX_TURNS", "ZCODE_CONFINE_TO_CWD"])
    delete env[k];
  const child = spawn(process.execPath, [CLI, ...args], { cwd: ws, env, timeout: 60_000 });
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
  return { status, stdout, stderr, json, requests: [...fake.state.requests] };
}

test("--max-turns 3: three model steps, the last one without tools, then a text answer", async () => {
  const r = await sando(
    "loop",
    "-p",
    "read the readme forever",
    "--mode",
    "yolo",
    "--json",
    "--max-turns",
    "3",
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.requests.length, 3);
  assert.deepEqual(
    r.requests.map((q) => q.toolCount > 0),
    [true, true, false],
  );
  assert.equal(r.json?.response, "final answer from model-a");
});

test("--model picks another registry model for this run only", async () => {
  const r = await sando(
    "text",
    "-p",
    "hi",
    "--mode",
    "yolo",
    "--json",
    "--model",
    "fake-b/model-b",
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.requests.map((q) => q.model),
    ["model-b"],
  );
  const saved = JSON.parse(
    fs.readFileSync(path.join(home, ".zcode", "v2", "provider_config.json"), "utf8"),
  );
  assert.deepEqual(saved.config.defaultModelSelection, {
    providerId: "fake-a",
    modelId: "model-a",
  });
});

test("bad --model / --max-turns / --harness values fail before any model call", async () => {
  for (const args of [
    ["--model", "fake-b/nope"],
    ["--model", "nope"],
    ["--max-turns", "0"],
    ["--harness", path.join(base, "missing")],
  ]) {
    const r = await sando("text", "-p", "hi", "--json", ...args);
    assert.equal(r.status, 1, `${args.join(" ")} should fail`);
    assert.equal(r.requests.length, 0, args.join(" "));
  }
});

test("--confine-to-cwd: Read outside the workspace is refused, inside still works", async () => {
  const confined = await sando(
    "confine",
    "-p",
    "read /etc/hostname",
    "--mode",
    "yolo",
    "--json",
    "--confine-to-cwd",
  );
  assert.equal(confined.status, 0, confined.stderr);
  assert.match(confined.requests[1].lastTool, /outside the workspace .*\(--confine-to-cwd\)/);

  const open = await sando("confine", "-p", "read /etc/hostname", "--mode", "yolo", "--json");
  assert.doesNotMatch(open.requests[1].lastTool, /confine-to-cwd/);

  const inside = await sando(
    "inside",
    "-p",
    "read README",
    "--mode",
    "yolo",
    "--json",
    "--confine-to-cwd",
  );
  assert.match(inside.requests[1].lastTool, /tiny workspace/);
});

test("--harness adds its AGENTS.md and skills to the run", async () => {
  const withHarness = await sando(
    "text",
    "-p",
    "hi",
    "--mode",
    "yolo",
    "--json",
    "--harness",
    harness,
  );
  assert.equal(withHarness.status, 0, withHarness.stderr);
  assert.match(withHarness.requests[0].all, /HARNESS-MARKER-7731/);
  assert.match(withHarness.requests[0].all, /HARNESS-SKILL-4410/);

  const without = await sando("text", "-p", "hi", "--mode", "yolo", "--json");
  assert.doesNotMatch(without.requests[0].all, /HARNESS-MARKER-7731|HARNESS-SKILL-4410/);
});
