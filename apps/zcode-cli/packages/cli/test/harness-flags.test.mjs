// Sando: flag parsing for --model / --harness / --max-turns / --confine-to-cwd.
// Run: pnpm exec tsx --test test/harness-flags.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { resolveSandoRunFlags } from "../src/harness-flags.ts";

test("no flags, no env", () => {
  assert.deepEqual(resolveSandoRunFlags({}, "/"), { env: {} });
});

test("valid flags map to env vars", () => {
  const r = resolveSandoRunFlags(
    {
      model: " forge-bonsai2/bonsai2-27b ",
      harness: os.tmpdir(),
      "max-turns": "12",
      "confine-to-cwd": true,
    },
    "/",
  );
  assert.deepEqual(r, {
    env: {
      ZCODE_MODEL: "forge-bonsai2/bonsai2-27b",
      ZCODE_HARNESS_DIR: os.tmpdir(),
      ZCODE_MAX_TURNS: "12",
      ZCODE_CONFINE_TO_CWD: "1",
    },
  });
});

test("harness path resolves against the base dir", () => {
  const r = resolveSandoRunFlags({ harness: "." }, os.tmpdir());
  assert.equal(r.env?.ZCODE_HARNESS_DIR, os.tmpdir());
});

test("bad values are errors", () => {
  for (const values of [
    { model: "nope" },
    { model: "/x" },
    { model: "x/" },
    { "max-turns": "0" },
    { "max-turns": "2.5" },
    { "max-turns": "-1" },
    { harness: "/definitely/not/here" },
  ]) {
    assert.ok("error" in resolveSandoRunFlags(values, "/"), JSON.stringify(values));
  }
});
