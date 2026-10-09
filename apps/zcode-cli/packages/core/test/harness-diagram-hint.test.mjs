// Sando: the always-on # Harness block tells the agent the workbench renders mermaid + KaTeX.
// identity.js imports @zcode/shared from TS source, so this reads the built module text instead of importing it.
// Run: pnpm --filter @zcode/core build && node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const built = fs.readFileSync(new URL("../dist/context/sections/identity.js", import.meta.url), "utf8");
const harness = built.slice(built.indexOf("function buildHarnessBlock"), built.indexOf("function buildIdentityPrompt"));

test("harness block asks for mermaid diagrams and $$ math", () => {
  assert.ok(harness.length > 0, "buildHarnessBlock found");
  assert.match(harness, /```mermaid/);
  assert.match(harness, /sequenceDiagram/);
  assert.match(harness, /\$\$\\u2026\$\$|\$\$…\$\$/);
  // small local models write unquoted labels with parentheses, which Mermaid rejects (renderer then shows source)
  assert.match(harness, /double quotes/);
});
