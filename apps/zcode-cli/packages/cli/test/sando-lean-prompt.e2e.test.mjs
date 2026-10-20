// Sando lean prompt profile end to end: the built CLI (dist/zcode.cjs) against the scripted local OpenAI server
// (127.0.0.1 = a local endpoint). Checks what goes on the wire per SANDO_PROMPT_PROFILE:
//   unset / default -> the full upstream prompt and tool surface
//   lean-local      -> short "You are Sando" prompt + Read/Write/Edit/Bash/TodoWrite with short descriptions
//   lean            -> same, regardless of endpoint
// and that a lean session still runs tools and resumes. Run: pnpm -r --filter "@zcode/cli..." run build && pnpm test
// (cli package). No GPU, no network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const CLI = new URL("../dist/zcode.cjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-lean-e2e-"));
const home = path.join(base, "home");
const ws = path.join(base, "ws");
const MODEL = "fake-forge/bonsai2-27b";
const LEAN_TOOLS = ["Bash", "Edit", "Read", "TodoWrite", "Write"];
let fake;

before(async () => {
  fake = await startFakeOpenAI();
  const modelConfig = {
    enabled: true,
    properties: {
      contextWindow: 65536,
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
  fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".zcode", "v2", "provider_config.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerOrder: ["fake-forge"],
        providerConfigRules: {
          providerRules: [
            {
              providerId: "fake-forge",
              enabled: true,
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "fake" },
                api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${fake.port}/v1` },
                personalModelIds: ["bonsai2-27b"],
                modelOrder: ["bonsai2-27b"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [],
          manualProviderModelRules: [{ providerId: "fake-forge", modelId: "bonsai2-27b", config: modelConfig }],
        },
        defaultModelSelection: { providerId: "fake-forge", modelId: "bonsai2-27b" },
      },
    }),
  );
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# tiny workspace\n");
  // Each user turn: step 1 reads README.md; step 2 answers.
  fake.state.handler = ({ msgs, tools }) => {
    const afterTool = msgs.at(-1)?.role === "tool";
    if (!afterTool && tools.includes("Read")) return { calls: [{ name: "Read", args: { file_path: "README.md" } }] };
    return { text: afterTool ? "read it" : "no tools" };
  };
});

after(async () => {
  await fake?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

async function sando(env, ...args) {
  fake.state.requests.length = 0;
  const childEnv = { ...process.env, HOME: home, ...env };
  for (const k of ["ZCODE_MODEL", "ZCODE_HARNESS_DIR", "ZCODE_MAX_TURNS", "ZCODE_CONFINE_TO_CWD", "SANDO_REASONING_HISTORY"])
    delete childEnv[k];
  if (env.SANDO_PROMPT_PROFILE === undefined) delete childEnv.SANDO_PROMPT_PROFILE;
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

const toolBytes = (request) => request.all.length - request.rawMessages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n").length;

test("unset: full default prompt and tool surface (unchanged)", async () => {
  const r = await sando({}, "-p", "read the readme", "--model", MODEL, "--json");
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const first = r.requests[0];
  assert.match(first.system, /^You are ZCode/);
  assert.match(first.system, /# Communicating with the user/);
  assert.ok(first.tools.includes("CreateWorkflow") && first.tools.includes("Agent"), first.tools.join(","));
  assert.ok(first.toolCount > 15, String(first.toolCount));
});

for (const profile of ["lean-local", "lean"]) {
  test(`${profile}: lean prompt + core tools on the wire, tools still run, --resume keeps the profile`, async () => {
    const env = { SANDO_PROMPT_PROFILE: profile };
    const t1 = await sando(env, "-p", "TURN1 read the readme", "--model", MODEL, "--json");
    assert.equal(t1.status, 0, t1.stderr.slice(-2000));
    assert.equal(t1.requests.length, 2, "tool step + answer step");
    const first = t1.requests[0];
    assert.match(first.system, /^You are Sando, a coding agent/);
    assert.doesNotMatch(first.system, /ZCode|# Memory|mermaid/);
    assert.ok(first.system.length < 2600, `system prompt ${first.system.length} chars`);
    assert.deepEqual([...first.tools].sort(), LEAN_TOOLS);
    assert.ok(toolBytes(first) < 6000, `tool schemas ${toolBytes(first)} bytes`);
    assert.match(t1.requests[1].lastTool ?? "", /tiny workspace/, "Read ran");
    assert.equal(t1.json.response.trim(), "read it");

    const t2 = await sando(env, "--resume", t1.json.sessionId, "-p", "TURN2 again", "--model", MODEL, "--json");
    assert.equal(t2.status, 0, t2.stderr.slice(-2000));
    assert.match(t2.requests[0].system, /^You are Sando/);
    assert.deepEqual([...t2.requests[0].tools].sort(), LEAN_TOOLS);
    assert.match(t2.requests[0].all, /TURN1 read the readme/, "history carried over");
  });
}

test("an unknown SANDO_PROMPT_PROFILE fails loudly instead of silently using a profile", async () => {
  const r = await sando({ SANDO_PROMPT_PROFILE: "tiny" }, "-p", "hi", "--model", MODEL, "--json");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + JSON.stringify(r.json ?? {}), /SANDO_PROMPT_PROFILE expects one of default, lean, lean-local/);
  assert.equal(r.requests.length, 0);
});
