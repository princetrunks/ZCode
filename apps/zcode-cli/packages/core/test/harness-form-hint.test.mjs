// Sando: the # Harness block tells the agent it may end a reply with one ```form block (web workbench renders it).
// Run: pnpm --filter @zcode/core build && node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const built = fs.readFileSync(new URL("../dist/context/sections/identity.js", import.meta.url), "utf8");
const harness = built.slice(built.indexOf("function buildHarnessBlock"), built.indexOf("function buildIdentityPrompt"));

test("harness block offers one ```form block for real decisions, never in voice", () => {
  assert.match(harness, /```form/);
  assert.match(harness, /ONE ```form/);
  assert.match(harness, /choice, multi, yesno, scale/);
  assert.match(harness, /Form answers:/);
  assert.match(harness, /never in voice/);
});
