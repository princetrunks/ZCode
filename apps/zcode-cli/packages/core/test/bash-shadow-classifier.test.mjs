// Sando shell gate (shadow): a stub llama.cpp server stands in for CRACK. Run: pnpm --filter @zcode/core build && node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyShellCommand, shadowClassifyBash } from "../dist/tool/handlers/bash-shadow-classifier.js";

function stub({ top, busy = false }) {
  const hits = { completion: 0 };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url.startsWith("/slots")) return res.end(JSON.stringify([{ id: 0, is_processing: busy }]));
        hits.completion++;
        res.end(JSON.stringify({ completion_probabilities: [{ top_logprobs: top.map(([token, p]) => ({ token, logprob: Math.log(p) })) }] }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits }));
  });
}
async function withStub(opts, fn) {
  const { srv, hits } = await stub(opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shellgate-"));
  process.env.FORGE_CRACK_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.SANDO_SHELL_GATE_LOG = path.join(dir, "shell-gate.jsonl");
  try { return await fn({ hits, log: process.env.SANDO_SHELL_GATE_LOG }); } finally { srv.close(); delete process.env.SANDO_SHELL_GATE; }
}

test("classifies by the most probable label (C = never_unattended)", async () => {
  await withStub({ top: [["C", 0.9], ["B", 0.08], ["A", 0.02]] }, async () => {
    const r = await classifyShellCommand({ command: "git push --force origin main" });
    assert.equal(r.kind, "never_unattended");
    assert.ok(r.probabilities.never_unattended > 0.85);
  });
});

test("returns null when the answer is unconstrained", async () => {
  await withStub({ top: [["The", 0.8], ["A", 0.2]] }, async () => {
    assert.equal(await classifyShellCommand({ command: "ls" }), null);
  });
});

test("shadow logs the verdict next to the rule decision", async () => {
  await withStub({ top: [["A", 0.95], ["B", 0.05]] }, async ({ log }) => {
    await shadowClassifyBash({ command: "git status", cwd: "/repo", mode: "build", ruleDecision: "allow", ruleId: "bash.readonly" });
    const row = JSON.parse(fs.readFileSync(log, "utf8").trim());
    assert.equal(row.would, "safe");
    assert.equal(row.rule_decision, "allow");
    assert.equal(row.mode, "shadow");
    assert.ok(row.latency_ms >= 0 && row.probabilities.safe > 0.9);
  });
});

test("busy CRACK: no completion call, a skipped line", async () => {
  await withStub({ top: [["A", 1]], busy: true }, async ({ hits, log }) => {
    await shadowClassifyBash({ command: "ls" });
    assert.equal(hits.completion, 0);
    assert.equal(JSON.parse(fs.readFileSync(log, "utf8").trim()).skipped, "crack_busy");
  });
});

test("SANDO_SHELL_GATE=off: nothing at all", async () => {
  await withStub({ top: [["A", 1]] }, async ({ hits, log }) => {
    process.env.SANDO_SHELL_GATE = "off";
    await shadowClassifyBash({ command: "ls" });
    assert.equal(hits.completion, 0);
    assert.equal(fs.existsSync(log), false);
  });
});
