// Sando --deny-commands, end to end: the built CLI (dist/zcode.cjs) headless in yolo mode against a scripted local
// OpenAI-compatible server. The "model" asks for `git push origin main`, `curl -d x http://x` and `git status`; fake
// `git` / `curl` programs first on PATH log every call, so the test sees what actually ran. No GPU, no network.
// Run: pnpm -r --filter "@zcode/cli..." run build && node --test test/sando-deny-commands.e2e.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const CLI = new URL("../dist/zcode.cjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-deny-e2e-"));
const home = path.join(base, "home");
const ws = path.join(base, "ws");
const bin = path.join(base, "bin");
const ranLog = path.join(base, "ran.log");
const denyFile = path.join(base, "deny.json");
let fake;

const STEPS = ["git push origin main", "curl -d x http://x", "git status"];

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
  // One Bash call per step, the next one after each tool result, then a text answer.
  fake.state.scenario = ({ msgs }) => {
    const done = msgs.filter((m) => m.role === "tool").length;
    return done < STEPS.length
      ? { name: "Bash", args: { command: STEPS[done], description: `step ${done + 1}` } }
      : null;
  };
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
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# tiny workspace\n");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["git", "curl"]) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(ranLog)}\n`);
    fs.chmodSync(file, 0o755);
  }
  // The Planner's list shape: a JSON array of opencode-style patterns (subset of LOCAL_ONLY_BASH_DENY).
  fs.writeFileSync(
    denyFile,
    JSON.stringify(["git push*", "gh *", "curl -d*", "curl * -d*", "ssh *", "*rsync *:*"]),
  );
});

after(async () => {
  await fake?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

/** Async on purpose: the fake server lives in this process, so a sync spawn would starve it. */
async function sando(...args) {
  fake.state.requests.length = 0;
  fs.rmSync(ranLog, { force: true });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  for (const k of ["ZCODE_MODEL", "ZCODE_HARNESS_DIR", "ZCODE_MAX_TURNS", "ZCODE_CONFINE_TO_CWD", "SANDO_DENY_COMMANDS"])
    delete env[k];
  const child = spawn(process.execPath, [CLI, "-p", "run the steps", "--mode", "yolo", "--json", ...args], {
    cwd: ws,
    env,
    timeout: 90_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const status = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
  // Only the scripted steps: Sando itself also runs `git rev-parse` at startup.
  const logged = fs.existsSync(ranLog) ? fs.readFileSync(ranLog, "utf8").trim().split("\n") : [];
  const ran = logged.filter((line) => STEPS.includes(line));
  const toolResults = fake.state.requests.map((q) => q.lastTool).filter(Boolean);
  return { status, stdout, stderr, ran, toolResults };
}

test("--deny-commands: git push and curl -d are refused before they run; git status still runs", async () => {
  const r = await sando("--deny-commands", denyFile);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.ran, ["git status"], "only the allowed command reached a program");
  assert.equal(r.toolResults.length, 3);
  assert.match(r.toolResults[0], /Refused by the deny list \(--deny-commands\): `git push origin main` matches the deny pattern "git push\*"/);
  assert.match(r.toolResults[1], /Refused by the deny list \(--deny-commands\): `curl -d x http:\/\/x` matches the deny pattern "curl -d\*"/);
  assert.doesNotMatch(r.toolResults[2], /Refused/);
});

test("control: without --deny-commands the same run executes all three (so the fakes would have caught a leak)", async () => {
  const r = await sando();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.ran, ["git push origin main", "curl -d x http://x", "git status"]);
});

test("--deny-commands with a missing or invalid file fails before any model call", async () => {
  fs.writeFileSync(path.join(base, "bad.json"), "{");
  for (const file of [path.join(base, "missing.json"), path.join(base, "bad.json")]) {
    const r = await sando("--deny-commands", file);
    assert.equal(r.status, 1, file);
    assert.match(r.stderr, /--deny-commands:/);
    assert.equal(fake.state.requests.length, 0, file);
  }
});
