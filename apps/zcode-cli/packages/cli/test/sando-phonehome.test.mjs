// Sando phonehome=none guard (RD-2828, 2026-10-29): fails when a vendor call-home path comes back.
// Run: pnpm exec tsx --test test/sando-phonehome.test.mjs
// After a deliberate, reviewed new external URL literal: SANDO_PHONEHOME_UPDATE_HOSTS=1 (rewrites the allowlist).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_BIGMODEL_API_ORIGIN,
  DEFAULT_ZAI_BUSINESS_BASE_URL,
  DEFAULT_ZAI_OAUTH_ORIGIN,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  PHONEHOME_NONE,
  SANDO_PHONEHOME,
  ZCODE_ARMS_RUM_ENDPOINT,
  ZCODE_TELEMETRY_ENABLED,
  ZCODE_TELEMETRY_REPORT_ENDPOINT,
  assertPhonehomeAllowed,
  resolveRuntimeProductEndpointConfig,
} from "../../../../../packages/shared/src/index.ts";
import { getCapturedZCodeAgentTelemetryEnv } from "../../../../../packages/shared/src/runtimeEnv.ts";
import { downloadZCodeBuiltinRelease } from "../../../../../packages/provider-node/src/zcode-builtin-download.ts";
import { ensureCliDeviceMid } from "../../adapters/src/device/cli-device-mid.ts";
import { resolveAnthropicRequestMetadataUserId } from "../../adapters/src/model/anthropic-request-metadata.ts";
import { resolveOfficialCodingPlanGatewayUrl } from "../../adapters/src/model/official-coding-plan-gateway.ts";
import {
  resolveOtlpMetricEndpoint,
  resolveOtlpTraceEndpoint,
} from "../../telemetry/src/bootstrap.ts";
import { loadBuiltinProviderConfig } from "../../../../../scripts/builtin-provider-config.mjs";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const HOSTS_FILE = resolve(import.meta.dirname, "sando-phonehome-hosts.json");
const OTEL_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.net",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.example.net/v1/traces",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://otel.example.net/v1/metrics",
};

function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./u.test(host);
}

function hostOf(url) {
  return new URL(url).hostname;
}

test("the fork defaults to phonehome none", () => {
  assert.equal(SANDO_PHONEHOME, "none");
  assert.equal(PHONEHOME_NONE, true);
});

test("default endpoint config is loopback only", () => {
  const config = resolveRuntimeProductEndpointConfig({});
  const urls = [
    DEFAULT_ZCODE_ENDPOINT_ORIGIN,
    DEFAULT_BIGMODEL_API_ORIGIN,
    DEFAULT_ZAI_OAUTH_ORIGIN,
    DEFAULT_ZAI_BUSINESS_BASE_URL,
    config.zcodeEndpointOrigin,
    config.zaiOAuthOrigin,
    config.zaiBusinessBaseUrl,
    config.bigModelApiOrigin,
    ...Object.values(config.zcodeEndpointUrls),
  ];
  for (const url of urls) assert.ok(isLoopbackHost(hostOf(url)), `non-loopback default: ${url}`);
});

test("telemetry, ARMS and OTEL are off even when their env is set", () => {
  assert.equal(ZCODE_TELEMETRY_ENABLED, false);
  assert.equal(ZCODE_TELEMETRY_REPORT_ENDPOINT, "");
  assert.equal(ZCODE_ARMS_RUM_ENDPOINT, "");
  assert.equal(resolveOtlpTraceEndpoint(OTEL_ENV), undefined);
  assert.equal(resolveOtlpMetricEndpoint(OTEL_ENV), undefined);
  assert.deepEqual(getCapturedZCodeAgentTelemetryEnv(), {});
});

test("config/default.json carries only user-click links", () => {
  const LINK_KEYS = new Set(["feedback_url", "community_urls"]);
  const config = JSON.parse(readFileSync(join(ROOT, "config/default.json"), "utf8"));
  for (const [key, value] of Object.entries(config)) {
    if (LINK_KEYS.has(key)) continue;
    const text = JSON.stringify(value);
    for (const match of text.matchAll(/https?:\/\/([^/"\\:]+)/gu)) {
      assert.ok(isLoopbackHost(match[1]), `config/default.json ${key} points at ${match[1]}`);
    }
  }
});

test("local Built-in catalogue has no Z.ai / BigModel providers or templates", async () => {
  const { content } = await loadBuiltinProviderConfig({ root: ROOT, env: { ZCODE_ENV: "production" } });
  const rules = JSON.parse(content).config.providerConfigRules;
  const vendor = /(^|\.)(z\.ai|bigmodel\.cn)$/u;
  // Built-in providers are active without any user step; ours must be loopback (today: none at all).
  for (const rule of rules.providerRules) {
    const host = hostOf(rule.config.api.baseUrl);
    assert.ok(isLoopbackHost(host), `built-in provider ${rule.providerId} → ${host}`);
  }
  for (const rule of rules.templateRules) {
    assert.ok(!vendor.test(hostOf(rule.config.api.baseUrl)), `vendor template ${rule.templateId}`);
    assert.ok(!String(rule.config.access?.type).startsWith("zhipu-"), `zhipu template ${rule.templateId}`);
  }
});

test("gated paths never touch the network or the device-ID file", async () => {
  const request = () => {
    throw new Error("catalogue download must not issue a request");
  };
  const release = await downloadZCodeBuiltinRelease({
    endpointOrigin: "https://zcode.z.ai",
    appVersion: "0.0.0",
    platform: "linux-x86_64",
    request,
  });
  assert.equal(release, null);

  const baseDir = mkdtempSync(join(tmpdir(), "sando-phonehome-"));
  assert.equal(await ensureCliDeviceMid({ baseDir }), "");
  assert.equal(existsSync(join(baseDir, ".zcode", "v2", "telemetry-state.json")), false);
  assert.equal(
    await resolveAnthropicRequestMetadataUserId({ env: {}, providerKind: "anthropic" }),
    undefined,
  );

  const gateway = resolveOfficialCodingPlanGatewayUrl("https://api.z.ai/api/anthropic/v1/messages", {});
  assert.equal(gateway.viaGateway, false);
});

test("HTTP chokepoints refuse vendor hosts", () => {
  for (const url of [
    "https://zcode.z.ai/api/v1/client/configs",
    "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
    "https://open.bigmodel.cn/api/anthropic",
    "https://chat.z.ai/api/oauth/authorize",
  ]) {
    assert.throws(() => assertPhonehomeAllowed(url), /phonehome: none/u, url);
  }
  assertPhonehomeAllowed("http://127.0.0.1:8099/v1/chat/completions");
  assertPhonehomeAllowed("https://example.org/");
});

// ---- ratchet: hard-coded external hosts in shipped source -------------------------------------
// Every (host, file) pair below was reviewed on 2026-10-29: vendor paths are gated by phonehome,
// the rest are user-click links, user-chosen provider templates, or user-initiated sources.
// A new external URL literal in product source fails here until it is reviewed and added.
const SOURCE_ROOTS = /^(apps\/zcode-cli\/packages\/[^/]+\/src|packages\/[^/]+\/src|config)\//u;
const SKIP_FILE =
  /(^|\/)(test|tests|__tests__|e2e|fixtures|__mocks__)\/|\.(test|spec|stories)\.|\.d\.ts$|\.md$|\/generated\//u;
const IGNORED_HOST =
  /^(localhost|127\.[\d.]+|\[?::1\]?|0\.0\.0\.0|www\.w3\.org)$|(^|\.)(example(\.(com|org|net))?|invalid|test|localhost|local|lan|internal|home\.arpa)$/u;

function scanExternalHosts() {
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => SOURCE_ROOTS.test(file) && !SKIP_FILE.test(file))
    .filter((file) => /\.(m?[jt]sx?|cjs|json|html|css)$/u.test(file));
  const found = {};
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue; // listed but deleted in the working tree
    }
    for (const match of text.matchAll(/https?:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9])/gu)) {
      const host = match[1].toLowerCase();
      if (IGNORED_HOST.test(host) || !host.includes(".")) continue;
      (found[host] ??= new Set()).add(file);
    }
  }
  return Object.fromEntries(
    Object.keys(found)
      .sort()
      .map((host) => [host, [...found[host]].sort()]),
  );
}

test("no new hard-coded external host in shipped source", () => {
  const current = scanExternalHosts();
  if (process.env.SANDO_PHONEHOME_UPDATE_HOSTS === "1") {
    writeFileSync(HOSTS_FILE, `${JSON.stringify(current, null, 2)}\n`);
    return;
  }
  const allowed = JSON.parse(readFileSync(HOSTS_FILE, "utf8"));
  const added = [];
  for (const [host, files] of Object.entries(current)) {
    for (const file of files) if (!allowed[host]?.includes(file)) added.push(`${host}  ${file}`);
  }
  assert.deepEqual(
    added,
    [],
    "new external URL literal(s); gate them behind PHONEHOME_NONE or review and re-run with SANDO_PHONEHOME_UPDATE_HOSTS=1",
  );
});

test("built CLI bundle has the call-home code compiled out", { skip: !existsSync(join(ROOT, "apps/zcode-cli/packages/cli/dist/zcode.cjs")) }, () => {
  const bundle = readFileSync(join(ROOT, "apps/zcode-cli/packages/cli/dist/zcode.cjs"), "utf8");
  assert.ok(!bundle.includes("__SANDO_PHONEHOME__"), "phonehome define was not applied");
  // esbuild 把门控折叠成常量；__esm 懒初始化模块里的无引用函数体不会被摇掉，故断言导出已是空实现。
  assert.ok(
    bundle.includes("downloadZCodeBuiltinRelease = async () => null"),
    "remote catalogue download is still wired in",
  );
  assert.ok(!/if \(PHONEHOME_NONE\)/u.test(bundle), "a phonehome gate was not folded to a constant");
  const staged = JSON.parse(
    readFileSync(join(ROOT, "apps/zcode-cli/packages/cli/dist/provider/zcode-builtin.json"), "utf8"),
  );
  assert.deepEqual(staged.config.providerConfigRules.providerRules, []);
});
