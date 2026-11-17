// Sando: per-model compaction headroom (SANDO-COMPACT-HEADROOM.md, SAN-4472). Upstream compacts at W - min(O, 21K) - 13K,
// ~35% of a 32K window; Sando compacts at min(W x 0.85, W - O - H) with O capped at W / 4 and H per model.
// Run: pnpm test in apps/zcode-cli/packages/core (tsx --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compactHeadroomModeFromEnv,
  defaultCompactHeadroomTokens,
  getAutoCompactHeadroomTokens,
  getAutoCompactOutputReserveTokens,
  getAutoCompactThreshold,
  shouldAutoCompact,
} from "../src/compact/policy.ts";

const at = (contextWindow, maxOutputTokens, extra = {}) => ({ contextWindow, maxOutputTokens, ...extra });

test("upstream mode keeps the upstream formula W - min(O, 21K) - 13K", () => {
  assert.equal(getAutoCompactThreshold(at(32_768, 8_192, { headroomMode: "upstream" })), 11_576);
  assert.equal(getAutoCompactThreshold(at(131_072, 8_192, { headroomMode: "upstream" })), 109_880);
  assert.equal(getAutoCompactThreshold(at(200_000, 32_000, { headroomMode: "upstream" })), 166_000);
  // 16K with 8K output: upstream threshold is 0, i.e. it compacts before every request.
  assert.equal(getAutoCompactThreshold(at(16_384, 8_192, { headroomMode: "upstream" })), 0);
});

test("default headroom by window: 16K 2K, 32K 3K, 64K 6K, 128K+ 13K", () => {
  assert.equal(defaultCompactHeadroomTokens(16_384), 2_000);
  assert.equal(defaultCompactHeadroomTokens(24_576), 2_000);
  assert.equal(defaultCompactHeadroomTokens(32_768), 3_000);
  assert.equal(defaultCompactHeadroomTokens(65_536), 6_000);
  assert.equal(defaultCompactHeadroomTokens(131_072), 13_000);
  assert.equal(defaultCompactHeadroomTokens(262_144), 13_000);
});

test("sando thresholds for the forge's windows", () => {
  // Lily / Qwythos / Gemma 32K, 8K out: 32768 - 8192 - 3000.
  assert.equal(getAutoCompactThreshold(at(32_768, 8_192)), 21_576);
  // Bonsai 2 64K, 8K out: 65536 - 8192 - 6000.
  assert.equal(getAutoCompactThreshold(at(65_536, 8_192)), 51_344);
  // CRACK 128K, 8K out: W - O - 13K (83.8%) is below W x 0.85, so 128K is unchanged.
  assert.equal(getAutoCompactThreshold(at(131_072, 8_192)), 109_880);
  // 16K, 8K out: the output reserve is capped at W / 4 = 4096.
  assert.equal(getAutoCompactOutputReserveTokens(at(16_384, 8_192)), 4_096);
  assert.equal(getAutoCompactThreshold(at(16_384, 8_192)), 10_288);
  // crack-voice 24K, 4K out.
  assert.equal(getAutoCompactThreshold(at(24_576, 4_096)), 18_480);
});

test("the W x 0.85 cap wins when O and H are small", () => {
  assert.equal(getAutoCompactThreshold(at(131_072, 1_024, { modelHeadroomTokens: 1_000 })), 111_411);
});

test("a model without an output limit no longer reserves 21K of a 32K window", () => {
  assert.equal(getAutoCompactOutputReserveTokens(at(32_768, undefined, { headroomMode: "upstream" })), 21_000);
  assert.equal(getAutoCompactOutputReserveTokens(at(32_768, undefined)), 8_192);
  assert.equal(getAutoCompactThreshold(at(32_768, undefined)), 21_576);
});

test("per-model headroom from the model config, and explicit bufferTokens still wins", () => {
  assert.equal(getAutoCompactHeadroomTokens(at(32_768, 8_192, { modelHeadroomTokens: 5_000 })), 5_000);
  assert.equal(getAutoCompactThreshold(at(32_768, 8_192, { modelHeadroomTokens: 5_000 })), 19_576);
  assert.equal(
    getAutoCompactThreshold(at(32_768, 8_192, { modelHeadroomTokens: 5_000, bufferTokens: 1_000 })),
    23_576,
  );
  // modelHeadroomTokens is ignored in upstream mode.
  assert.equal(getAutoCompactThreshold(at(32_768, 8_192, { headroomMode: "upstream", modelHeadroomTokens: 1 })), 11_576);
});

test("SANDO_COMPACT_HEADROOM: unset/auto/on = sando, upstream/off = upstream, anything else throws", () => {
  assert.equal(compactHeadroomModeFromEnv({}), "sando");
  assert.equal(compactHeadroomModeFromEnv({ SANDO_COMPACT_HEADROOM: "auto" }), "sando");
  assert.equal(compactHeadroomModeFromEnv({ SANDO_COMPACT_HEADROOM: " ON " }), "sando");
  assert.equal(compactHeadroomModeFromEnv({ SANDO_COMPACT_HEADROOM: "upstream" }), "upstream");
  assert.equal(compactHeadroomModeFromEnv({ SANDO_COMPACT_HEADROOM: "off" }), "upstream");
  assert.throws(() => compactHeadroomModeFromEnv({ SANDO_COMPACT_HEADROOM: "big" }), /SANDO_COMPACT_HEADROOM/);
});

test("shouldAutoCompact on a 32K window: 15K tokens compacts upstream, not with sando headroom", () => {
  const messages = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `message ${i}`,
  }));
  const tokenOverride = { tokenCount: 15_000, source: "provider" };
  const upstream = shouldAutoCompact({ messages, config: at(32_768, 8_192, { headroomMode: "upstream" }), tokenOverride });
  const sando = shouldAutoCompact({ messages, config: at(32_768, 8_192), tokenOverride });
  assert.equal(upstream.shouldCompact, true);
  assert.equal(upstream.headroomMode, "upstream");
  assert.equal(upstream.headroomTokens, 13_000);
  assert.equal(sando.shouldCompact, false);
  assert.equal(sando.reason, "below_threshold");
  assert.equal(sando.threshold, 21_576);
  assert.equal(sando.headroomTokens, 3_000);
  const full = shouldAutoCompact({ messages, config: at(32_768, 8_192), tokenOverride: { tokenCount: 22_000, source: "provider" } });
  assert.equal(full.shouldCompact, true);
});

