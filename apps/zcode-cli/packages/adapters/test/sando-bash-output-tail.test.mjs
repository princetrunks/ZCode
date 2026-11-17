// Sando: a truncated Bash result carries the output file's last bytes (tailText), so the spill preview can show the
// end of a long log. Run: pnpm test in apps/zcode-cli/packages/adapters (tsx --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BashFileOutput } from "../src/exec/bash-file-output.ts";

async function outputWith(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sando-bash-tail-"));
  const out = new BashFileOutput(path.join(dir, "t-stdout.log"), process.platform, null);
  await out.prepare();
  fs.appendFileSync(out.path, text);
  await out.close();
  return { out, dir };
}

test("truncated result: text is the head, tailText is the real end of the file", async () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `[build] unit ${i} ok`);
  const { out, dir } = await outputWith(`${lines.join("\n")}\nerror: LAST LINE\n`);
  const r = await out.result(30_000);
  assert.equal(r.truncated, true);
  assert.ok(r.text.startsWith("[build] unit 0 ok"));
  assert.ok(!r.text.includes("LAST LINE"));
  assert.ok(r.tailText.endsWith("error: LAST LINE\n"));
  assert.ok(r.tailText.length <= 4096);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("untruncated result has no tailText (nothing changes for short output)", async () => {
  const { out, dir } = await outputWith("hello\n");
  const r = await out.result(30_000);
  assert.equal(r.truncated, false);
  assert.equal(r.tailText, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
