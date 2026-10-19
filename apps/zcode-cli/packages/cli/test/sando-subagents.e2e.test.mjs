// Sando native subagents (SANDO-SUBAGENTS.md), end to end through the built CLI (dist/zcode.cjs) against the scripted
// local OpenAI-compatible server, with a throwaway HOME and workspace. No GPU, no network.
// The parent is the request that offers the Agent tool; a child is the request whose system prompt has "# Reporting back".
// Run: pnpm -r --filter "@zcode/cli..." run build && node --test test/sando-subagents.e2e.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const CLI = new URL("../dist/zcode.cjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-subagents-e2e-"));
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
  fs.mkdirSync(path.join(ws, ".zcode", "agents"), { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# tiny workspace\nREADME-MARKER-3141\n");
  fs.writeFileSync(
    path.join(ws, ".zcode", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reads code and reports; never edits.\ntools: Read, Grep\nmodel: fake-b/model-b\nmaxTurns: 4\n---\nREVIEWER-SYSTEM-55: you review, you never write.\n",
  );
});

after(async () => {
  await fake?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

const isChild = (r) => r.system.includes("# Reporting back");
const isParent = (r) => r.tools.includes("Agent");

/** Async on purpose: the fake server lives in this process, so a sync spawn would starve it. */
async function sando(handler, args, extraEnv = {}) {
  fake.state.handler = (r) => {
    const role = isChild(r) ? "child" : isParent(r) ? "parent" : "other";
    return { role, ...handler({ ...r, role }) };
  };
  fake.state.requests.length = 0;
  fake.state.peakInflight = 0;
  const env = { ...process.env, HOME: home, ...extraEnv };
  for (const k of ["ZCODE_MODEL", "ZCODE_HARNESS_DIR", "ZCODE_MAX_TURNS", "ZCODE_CONFINE_TO_CWD"])
    if (!(k in extraEnv)) delete env[k];
  const child = spawn(process.execPath, [CLI, ...args], { cwd: ws, env, timeout: 90_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const status = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
  fake.state.handler = null;
  const requests = [...fake.state.requests];
  return {
    status,
    stdout,
    stderr,
    requests,
    parent: requests.filter((r) => r.role === "parent"),
    children: requests.filter((r) => r.role === "child"),
    peak: fake.state.peakInflight,
  };
}

const toolNames = (r) => [...r.all.matchAll(/"function":\{"name":"([^"]+)"/g)].map((m) => m[1]);
const agentCall = (args) => ({ name: "Agent", args: { description: "child job", ...args } });

test("a child runs on its own model and context, and returns only a compact result", async () => {
  const r = await sando(
    (q) => {
      if (q.role === "parent")
        return q.lastTool
          ? { text: "PARENT-DONE" }
          : {
              calls: [
                agentCall({
                  prompt: "CHILD-TASK-7: write notes.md, then report.",
                  model: "model-b",
                  max_turns: 5,
                }),
              ],
            };
      if (q.role === "child")
        return q.lastTool
          ? { text: "CHILD-RESULT: wrote notes.md" }
          : {
              calls: [
                { name: "Write", args: { file_path: "notes.md", content: "TRANSCRIPT-ONLY-9\n" } },
              ],
            };
      return { text: "ok" };
    },
    ["-p", "PARENT-PROMPT-1: delegate the notes", "--mode", "yolo", "--json"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.children.length, 2, "child: Write, then answer");
  for (const c of r.children) {
    assert.equal(c.model, "model-b", "the child runs on the model the call asked for");
    assert.ok(!toolNames(c).includes("Agent") && !toolNames(c).includes("Task"), "no nesting");
    assert.ok(
      !c.all.includes("PARENT-PROMPT-1"),
      "the child does not see the parent's conversation",
    );
  }
  assert.ok(r.children[0].all.includes("CHILD-TASK-7"));
  assert.match(r.children[0].system, /cut at about 6000 bytes/);
  assert.match(r.children[0].system, /at most 5 model steps/);
  assert.ok(
    r.parent.every((p) => p.model === "model-a"),
    "the parent stays on its own model",
  );
  const result = r.parent.at(-1).lastTool;
  assert.match(result, /CHILD-RESULT: wrote notes\.md/);
  assert.match(result, /model: fake-b\/model-b/);
  assert.match(result, /files_touched: notes\.md/);
  assert.match(result, /turn_cap: 5/);
  assert.ok(!result.includes("TRANSCRIPT-ONLY-9"), "the child's tool calls never reach the parent");
  assert.equal(fs.readFileSync(path.join(ws, "notes.md"), "utf8"), "TRANSCRIPT-ONLY-9\n");
  assert.match(r.stdout, /PARENT-DONE/);
  fs.rmSync(path.join(ws, "notes.md"));
});

test("max_turns caps the child: exactly that many steps, the last one without tools", async () => {
  const r = await sando(
    (q) => {
      if (q.role === "parent")
        return q.lastTool
          ? { text: "PARENT-DONE" }
          : { calls: [agentCall({ prompt: "read forever", max_turns: 2 })] };
      if (q.role === "child")
        return q.tools.includes("Read")
          ? { calls: [{ name: "Read", args: { file_path: "README.md" } }] }
          : { text: "CAPPED-ANSWER" };
      return { text: "ok" };
    },
    ["-p", "delegate", "--mode", "yolo", "--json"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.children.length, 2);
  assert.ok(r.children[0].toolCount > 0);
  assert.equal(r.children[1].toolCount, 0, "last allowed step offers no tools");
  assert.match(r.parent.at(-1).lastTool, /CAPPED-ANSWER/);
  assert.match(r.parent.at(-1).lastTool, /turn_cap: 2/);
});

test("three parallel children: at most two run at once (default cap), all three report", async () => {
  const r = await sando(
    (q) => {
      if (q.role === "parent")
        return q.lastTool
          ? { text: "PARENT-DONE" }
          : {
              calls: [1, 2, 3].map((i) =>
                agentCall({ description: `job ${i}`, prompt: `PARALLEL-JOB-${i}` }),
              ),
            };
      if (q.role === "child") {
        const job = /PARALLEL-JOB-(\d)/.exec(q.all)?.[1];
        return { text: `JOB-${job}-DONE`, delayMs: 700 };
      }
      return { text: "ok" };
    },
    ["-p", "fan out", "--mode", "yolo", "--json"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.children.length, 3);
  assert.equal(r.peak, 2, "two children in flight at once, never three");
  const last = r.parent.at(-1).all;
  for (const i of [1, 2, 3]) assert.match(last, new RegExp(`JOB-${i}-DONE`));
});

test("a long child answer is cut to the byte budget; the full text is saved for the parent", async () => {
  const long = "HEAD-OK: the answer comes first.\n" + "filler line\n".repeat(2000);
  const r = await sando(
    (q) => {
      if (q.role === "parent")
        return q.lastTool
          ? { text: "PARENT-DONE" }
          : { calls: [agentCall({ prompt: "report at length" })] };
      if (q.role === "child") return { text: long };
      return { text: "ok" };
    },
    ["-p", "delegate", "--mode", "yolo", "--json"],
    { ZCODE_SUBAGENT_RESULT_BYTES: "1000" },
  );
  assert.equal(r.status, 0, r.stderr);
  const result = r.parent.at(-1).lastTool;
  assert.match(result, /HEAD-OK/);
  assert.match(result, /cut to the 1000-byte budget/);
  const file = /in (\S+result\.md)/.exec(result)?.[1];
  assert.ok(file, result);
  assert.equal(fs.readFileSync(file, "utf8"), long);
  assert.ok(result.length < 2500, `parent saw ${result.length} chars`);
});

test("--confine-to-cwd reaches the child: Read outside the workspace is refused", async () => {
  const r = await sando(
    (q) => {
      if (q.role === "parent")
        return q.lastTool
          ? { text: "PARENT-DONE" }
          : { calls: [agentCall({ prompt: "peek outside" })] };
      if (q.role === "child")
        return q.lastTool
          ? { text: "CHILD-SAW-REFUSAL" }
          : { calls: [{ name: "Read", args: { file_path: "/etc/hostname" } }] };
      return { text: "ok" };
    },
    ["-p", "delegate", "--mode", "yolo", "--json", "--confine-to-cwd"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.children[1].lastTool, /outside the workspace .*\(--confine-to-cwd\)/);
});

test("an agent definition sets the child's system prompt, tools and model", async () => {
  const r = await sando(
    (q) => {
      if (q.role === "parent")
        return q.lastTool
          ? { text: "PARENT-DONE" }
          : { calls: [agentCall({ subagent_type: "reviewer", prompt: "review README.md" })] };
      if (q.role === "child") return { text: "REVIEW-OK" };
      return { text: "ok" };
    },
    ["-p", "get a review", "--mode", "yolo", "--json"],
  );
  assert.equal(r.status, 0, r.stderr);
  const child = r.children[0];
  assert.equal(child.model, "model-b", "profile model");
  assert.match(child.system, /REVIEWER-SYSTEM-55/);
  const tools = toolNames(child).filter((t) => !/coordinator/i.test(t));
  assert.deepEqual(tools.sort(), ["Grep", "Read"]);
  assert.match(child.system, /at most 4 model steps/, "profile maxTurns is the cap");
  assert.match(r.parent.at(-1).lastTool, /REVIEW-OK/);
});

test("an unknown model fails the call with candidates and starts no child", async () => {
  const r = await sando(
    (q) => {
      if (q.role === "parent")
        return q.lastTool
          ? { text: "PARENT-DONE" }
          : { calls: [agentCall({ prompt: "x", model: "nope/none" })] };
      return { text: "should not run" };
    },
    ["-p", "delegate", "--mode", "yolo", "--json"],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.children.length, 0);
  assert.match(r.parent.at(-1).lastTool, /agent_model_not_found/);
  assert.match(r.parent.at(-1).lastTool, /fake-b\/model-b/);
});
