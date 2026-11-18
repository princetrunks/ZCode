// Sando --sandbox, end to end (SANDO-OS-SANDBOX.md, SAN-4472 port 3): the built CLI (dist/zcode.cjs) headless in yolo
// mode against a scripted local OpenAI-compatible server. The "model" runs Bash commands that try to read ~/.ssh,
// write outside the workspace and open sockets (TCP to the fake model server itself, a unix socket the test listens
// on), then normal build/test work in the workspace. Needs a Linux host with Landlock (or bwrap); skips otherwise.
// No GPU, no network.
// Run: pnpm -r --filter "@zcode/cli..." run build && node --test test/sando-os-sandbox.e2e.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAI } from "./fake-openai-server.mjs";

const CLI = new URL("../dist/zcode.cjs", import.meta.url).pathname;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "sando-os-sandbox-e2e-"));
const home = path.join(base, "home");
const ws = path.join(base, "ws");
const outside = path.join(base, "outside");
const unixSock = path.join(base, "s.sock");
let fake;
let unixServer;
let unixHits = 0;
let tcpHits = 0;
let tcpServer;
let tcpPort;

// Landlock usable on this host? (Probe once with the same launcher the CLI uses: python3 + the landlock syscalls.)
const hasLandlock =
  process.platform === "linux" &&
  Number(
    spawnSync(
      "python3",
      [
        "-c",
        "import ctypes;l=ctypes.CDLL(None);l.syscall.restype=ctypes.c_long;print(l.syscall(444,None,0,1))",
      ],
      {
        encoding: "utf8",
      },
    ).stdout?.trim(),
  ) >= 1;
const skip = hasLandlock ? false : "needs Linux with Landlock";

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
            { providerId: "fake-a", modelId: "model-a", config: modelConfig },
          ],
        },
        defaultModelSelection: { providerId: "fake-a", modelId: "model-a" },
      },
    }),
  );
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "SSH-KEY-SECRET\n");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "notes.txt"), "OUTSIDE-SECRET\n");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# tiny workspace\n");
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "tiny", type: "module" }));
  fs.writeFileSync(path.join(ws, "add.js"), "export const add = (a, b) => a + b;\n");
  fs.writeFileSync(
    path.join(ws, "add.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "./add.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n',
  );
  unixServer = net.createServer((c) => {
    c.on("error", () => {});
    unixHits += 1;
    c.end("hi");
  });
  await new Promise((resolve) => unixServer.listen(unixSock, resolve));
  tcpServer = net.createServer((c) => {
    c.on("error", () => {});
    tcpHits += 1;
    c.end();
  });
  await new Promise((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
  tcpPort = tcpServer.address().port;
});

after(async () => {
  await fake?.close();
  unixServer?.close();
  tcpServer?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

/** steps: one tool call per model request ({ name, args } or a Bash command string). Async: the fake server is in-process. */
async function sando(steps, args = [], env = {}) {
  fake.state.requests.length = 0;
  fake.state.scenario = ({ msgs }) => {
    const step = steps[msgs.filter((m) => m.role === "tool").length];
    if (!step) return null;
    return typeof step === "string"
      ? { name: "Bash", args: { command: step, description: "step" } }
      : step;
  };
  const childEnv = { ...process.env, HOME: home, ...env };
  delete childEnv.NODE_TEST_CONTEXT; // the outer node --test would make the workspace's `node --test` skip its files
  for (const k of [
    "ZCODE_MODEL",
    "ZCODE_CONFINE_TO_CWD",
    "SANDO_DENY_COMMANDS",
    "SANDO_SANDBOX",
    "SANDO_SANDBOX_WIDEN",
    "SANDO_SANDBOX_RUNNER",
  ]) {
    if (!(k in env)) delete childEnv[k];
  }
  const child = spawn(
    process.execPath,
    [CLI, "-p", "run the steps", "--mode", "yolo", "--json", ...args],
    {
      cwd: ws,
      env: childEnv,
      timeout: 120_000,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const status = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
  const toolResults = fake.state.requests.map((q) => q.lastTool).filter(Boolean);
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { status, stdout, stderr, toolResults, json, requests: fake.state.requests.length };
}

const ATTACKS = () => [
  `cat ${home}/.ssh/id_ed25519`,
  `cat ${outside}/notes.txt`,
  `echo pwned > ${outside}/w1.txt`,
  `python3 -c "open('${outside}/w2.txt','w').write('x')"`,
  `node -e "require('fs').writeFileSync('${outside}/w3.txt','x')"`,
  `python3 -c "import socket; socket.create_connection(('127.0.0.1', ${tcpPort}), 2); print('TCP-CONNECTED')"`,
  `node -e "require('net').connect(${tcpPort}, '127.0.0.1').on('connect', () => console.log('TCP-CONNECTED')).on('error', e => { console.error(e.code); process.exit(3) })"`,
  `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${unixSock}'); print('UNIX-CONNECTED')"`,
];

test(
  "--sandbox workspace-write: ~/.ssh, writes outside the workspace and sockets are blocked",
  { skip },
  async () => {
    tcpHits = 0;
    unixHits = 0;
    const attacks = ATTACKS();
    const r = await sando(attacks, ["--sandbox", "workspace-write"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.toolResults.length, attacks.length);
    const all = r.toolResults.join("\n");
    assert.doesNotMatch(all, /SSH-KEY-SECRET|OUTSIDE-SECRET|TCP-CONNECTED|UNIX-CONNECTED/);
    for (const [i, text] of r.toolResults.entries()) {
      assert.match(
        text,
        /Permission denied|Operation not permitted|EACCES|EPERM/i,
        `step ${i + 1}: ${attacks[i]}\n${text}`,
      );
    }
    assert.deepEqual(
      fs.readdirSync(outside),
      ["notes.txt"],
      "nothing was written outside the workspace",
    );
    assert.equal(tcpHits, 0, "no TCP connection reached the listener");
    assert.equal(unixHits, 0, "no unix-socket connection reached the listener");
    assert.match(
      r.toolResults[0],
      /Sando sandbox \(workspace-write\)/,
      "a denial carries the sandbox note",
    );
    assert.equal(r.json?.sandbox?.mode, "workspace-write");
    assert.match(r.json?.sandbox?.runner ?? "", /^(landlock|bwrap)$/);
    assert.equal(r.json?.sandbox?.enforcement, "full");
  },
);

test(
  "--sandbox: credentials in the environment do not reach the sandboxed shell",
  { skip },
  async () => {
    const r = await sando(
      ['echo "hf=[$HF_TOKEN] civ=[$CIVITAI_API_KEY] keep=[$KEEP_ME]"'],
      ["--sandbox", "workspace-write"],
      {
        HF_TOKEN: "hf-canary-123",
        CIVITAI_API_KEY: "civ-canary-456",
        KEEP_ME: "kept",
      },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.toolResults[0], /hf=\[\] civ=\[\] keep=\[kept\]/);
  },
);

test(
  "control: without --sandbox the same commands get through (so the checks above would catch a leak)",
  { skip },
  async () => {
    tcpHits = 0;
    unixHits = 0;
    const r = await sando(ATTACKS());
    assert.equal(r.status, 0, r.stderr);
    const all = r.toolResults.join("\n");
    assert.match(all, /SSH-KEY-SECRET/);
    assert.match(all, /TCP-CONNECTED/);
    assert.match(all, /UNIX-CONNECTED/);
    assert.ok(fs.existsSync(path.join(outside, "w1.txt")));
    assert.equal(r.json?.sandbox, undefined);
    for (const f of ["w1.txt", "w2.txt", "w3.txt"])
      fs.rmSync(path.join(outside, f), { force: true });
  },
);

test(
  "--sandbox workspace-write: normal build and test commands in the workspace work",
  { skip },
  async () => {
    const r = await sando(
      [
        "echo built > out.txt && mkdir -p dist && cp add.js dist/ && cat out.txt",
        "node --test 2>&1 | grep -E '(pass|fail) [0-9]'",
        "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm init && git log --oneline | wc -l",
        `python3 -c "import tempfile,os; f=tempfile.NamedTemporaryFile(delete=False); f.write(b'x'); print('TMP-OK', os.path.dirname(f.name) == os.environ['TMPDIR'])"`,
        "cd dist && pwd",
        "pwd",
      ],
      ["--sandbox", "workspace-write"],
    );
    assert.equal(r.status, 0, r.stderr);
    const [build, tests, git, tmp, cdDist, pwd] = r.toolResults;
    assert.match(build, /built/);
    assert.match(tests, /pass 1/);
    assert.match(tests, /fail 0/);
    assert.match(git, /\b1\b/);
    assert.match(tmp, /TMP-OK True/);
    assert.match(cdDist, /\/dist\b/);
    assert.match(pwd, /\/dist\b/, "the cwd carried over: the cwd capture works inside the sandbox");
    assert.ok(fs.existsSync(path.join(ws, "dist", "add.js")));
  },
);

test("--sandbox read-only: the workspace is readable but not writable", { skip }, async () => {
  const r = await sando(["cat README.md", "echo x > ro.txt"], ["--sandbox", "read-only"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.toolResults[0], /tiny workspace/);
  assert.match(r.toolResults[1], /permission denied/i);
  assert.ok(!fs.existsSync(path.join(ws, "ro.txt")));
});

test(
  "--sandbox: the file tools are confined to the workspace too (Read ~/.ssh refused)",
  { skip },
  async () => {
    const r = await sando(
      [{ name: "Read", args: { file_path: path.join(home, ".ssh", "id_ed25519") } }],
      ["--sandbox", "workspace-write"],
    );
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.toolResults[0], /SSH-KEY-SECRET/);
  },
);

test("no usable sandbox (unsupported kernel) = refuses to run before any model request", async () => {
  const r = await sando(["echo hi"], ["--sandbox", "workspace-write"], {
    SANDO_SANDBOX_RUNNER: "none",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no usable OS sandbox on this host/);
  assert.match(r.stderr, /--sandbox-widen unconfined/);
  assert.equal(r.requests, 0);
});

test("no usable sandbox + --sandbox-widen unconfined = runs unconfined and says so in the JSON", async () => {
  const r = await sando(
    ["echo ran-unconfined"],
    ["--sandbox", "workspace-write", "--sandbox-widen", "unconfined"],
    {
      SANDO_SANDBOX_RUNNER: "none",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.toolResults[0], /ran-unconfined/);
  assert.deepEqual(r.json?.sandbox, {
    mode: "workspace-write",
    runner: "none",
    enforcement: "none",
    widen: "unconfined",
  });
});

test(
  "one approved widening: --sandbox-widen one-call lets ONE dangerouslyDisableSandbox call out; others are refused",
  { skip },
  async () => {
    const unsandboxed = (file) => ({
      name: "Bash",
      args: {
        command: `echo w > ${outside}/${file}`,
        description: "outside",
        dangerouslyDisableSandbox: true,
      },
    });
    const refused = await sando([unsandboxed("nope.txt")], ["--sandbox", "workspace-write"]);
    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.toolResults[0], /was not approved for this run/);
    assert.ok(!fs.existsSync(path.join(outside, "nope.txt")));

    const r = await sando(
      [unsandboxed("one.txt"), unsandboxed("two.txt")],
      ["--sandbox", "workspace-write", "--sandbox-widen", "one-call"],
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.toolResults[0], /ran unsandboxed, as the one approved widening/);
    assert.match(r.toolResults[1], /already used/);
    assert.ok(fs.existsSync(path.join(outside, "one.txt")));
    assert.ok(!fs.existsSync(path.join(outside, "two.txt")));
    fs.rmSync(path.join(outside, "one.txt"), { force: true });
  },
);

test("bad --sandbox / --sandbox-widen values fail before any model request", async () => {
  for (const args of [
    ["--sandbox", "maybe"],
    ["--sandbox", "workspace-write", "--sandbox-widen", "always"],
  ]) {
    const r = await sando(["echo hi"], args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /--sandbox(-widen)?: /);
    assert.equal(r.requests, 0);
  }
});
