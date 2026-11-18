// Sando lean re-read nudge, end to end: the built CLI (dist/zcode.cjs) headless in yolo mode against a scripted local
// OpenAI-compatible server (no GPU, no network). The "model" reads the same unchanged file several times; the test reads
// what the next request carried. Lean = content again with a note; default profile = upstream "Wasted call" stub.
// Run: pnpm -r --filter "@zcode/cli..." run build && node --test test/sando-read-repeat.e2e.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const CLI = new URL("../dist/zcode.cjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-reread-e2e-"));
const home = path.join(base, "home");
const ws = path.join(base, "ws");
const readme = path.join(ws, "README.md");
let fake;

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
  fs.writeFileSync(readme, "# tiny workspace\nE_README_MARKER\n");
  writeProviderConfig(131072);
});

after(async () => {
  await fake?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

/** Async on purpose: the fake server lives in this process, so a sync spawn would starve it. */
async function sando(reads, profile, extraEnv = {}) {
  const steps = typeof reads === "number" ? Array(reads).fill({ name: "Read", args: { file_path: readme } }) : reads;
  fake.state.requests.length = 0;
  fake.state.scenario = ({ msgs }) => steps[msgs.filter((m) => m.role === "tool").length] ?? null;
  const env = { ...process.env, HOME: home, SANDO_PROMPT_PROFILE: profile, ...extraEnv };
  for (const k of ["ZCODE_MODEL", "ZCODE_HARNESS_DIR", "ZCODE_MAX_TURNS", "ZCODE_CONFINE_TO_CWD"]) delete env[k];
  const child = spawn(process.execPath, [CLI, "-p", "read the readme", "--mode", "yolo", "--json"], {
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

test("lean: re-reads of an unchanged file return the content with a nudge; the 8th is refused", async () => {
  const r = await sando(8, "lean");
  assert.equal(r.status, 0, r.stderr);
  const results = toolTexts(r.requests.at(-1));
  assert.equal(results.length, 8);
  for (const i of [0, 1, 2, 3, 4, 5, 6]) assert.match(results[i], /E_README_MARKER/, `read ${i + 1} has the content`);
  assert.doesNotMatch(results.join("\n"), /Wasted call/);
  assert.match(results[1], /Unchanged since you last read it this turn \(read 2 times\)/);
  assert.match(results[2], /read this unchanged file 3 times this turn/);
  assert.match(results[7], /Refused: this is read 8 of the same unchanged file range/);
});

test("default profile: upstream behaviour, the 2nd read is the Wasted call stub", async () => {
  const r = await sando(2, "default");
  assert.equal(r.status, 0, r.stderr);
  const results = toolTexts(r.requests.at(-1));
  assert.match(results[0], /E_README_MARKER/);
  assert.match(results[1], /^Wasted call/);
});

test("SANDO_LEAN_SMALLEST_EDIT with an unknown value fails at startup, before any model request", async () => {
  const r = await sando(1, "lean", { SANDO_LEAN_SMALLEST_EDIT: "maybe" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SANDO_LEAN_SMALLEST_EDIT expects on or off/);
  assert.equal(r.requests.length, 0);
});

test("SANDO_LEAN_SMALLEST_EDIT=off: the lean system prompt carries step 2 without the phrase", async () => {
  const on = await sando(0, "lean");
  const off = await sando(0, "lean", { SANDO_LEAN_SMALLEST_EDIT: "off" });
  assert.equal(on.status, 0, on.stderr);
  assert.equal(off.status, 0, off.stderr);
  const system = (r) => JSON.stringify(r.requests[0].rawMessages.filter((m) => m.role === "system"));
  assert.match(system(on), /smallest correct edit/);
  assert.doesNotMatch(system(off), /smallest/);
  assert.match(system(off), /2\. Make the change\. Follow/);
});

test("lean: a Read after the model's own Edit shows the new content with no note (upstream says Wasted call)", async () => {
  const file = path.join(ws, "notes.txt");
  const steps = [
    { name: "Read", args: { file_path: file } },
    { name: "Edit", args: { file_path: file, old_string: "v1", new_string: "v2_EDITED" } },
    { name: "Read", args: { file_path: file } },
  ];
  fs.writeFileSync(file, "v1\n");
  const lean = toolTexts((await sando(steps, "lean")).requests.at(-1));
  assert.match(lean[2], /v2_EDITED/);
  assert.doesNotMatch(lean[2], /Unchanged|Wasted|Refused/);
  fs.writeFileSync(file, "v1\n");
  const upstream = toolTexts((await sando(steps, "default")).requests.at(-1));
  assert.match(upstream[2], /^Wasted call/);
});
