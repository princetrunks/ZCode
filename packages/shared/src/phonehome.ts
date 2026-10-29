/**
 * Sando build switch `phonehome` (RD-2828, 2026-10-29).
 *
 * "none" (the fork default) compiles out every vendor call-home path: the zcode.z.ai remote
 * Built-in catalogue / client-config fetch, the device ID (telemetry-state.json), OTEL exporters,
 * update checks, and the Z.ai / BigModel login + endpoint defaults. Bundlers replace
 * `__SANDO_PHONEHOME__` (CLI esbuild, web/server builds) so the gated branches are dropped;
 * unbundled code (tsc, tests) falls back to "none" as well. Build with `SANDO_PHONEHOME=upstream`
 * only to reproduce upstream behaviour.
 */
declare const __SANDO_PHONEHOME__: string | undefined;

// 单个布尔表达式：esbuild 在 define 后能跨模块内联并删掉被门控的分支。
export const PHONEHOME_NONE: boolean =
  typeof __SANDO_PHONEHOME__ === "undefined" || __SANDO_PHONEHOME__ !== "upstream";

export const SANDO_PHONEHOME: "none" | "upstream" = PHONEHOME_NONE ? "none" : "upstream";

/**
 * Stand-in origin for vendor endpoints when phonehome is "none": the discard port on loopback.
 * Anything that still builds a vendor URL from the defaults gets a refused local connection,
 * never a DNS lookup or an external packet.
 */
export const PHONEHOME_DISABLED_ORIGIN = "http://127.0.0.1:9";

/** Vendor hosts that phonehome=none never contacts (keep in sync with scripts/sando-phonehome.mjs). */
export const PHONEHOME_VENDOR_HOST_SUFFIXES: readonly string[] = ["z.ai", "bigmodel.cn"];

export function isPhonehomeVendorUrl(input: string | URL): boolean {
  let host: string;
  try {
    host = new URL(String(input)).hostname.toLowerCase();
  } catch {
    return false;
  }
  return PHONEHOME_VENDOR_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/** Defence in depth at the HTTP chokepoints: refuse vendor hosts before any DNS lookup or connect. */
export function assertPhonehomeAllowed(input: string | URL): void {
  if (PHONEHOME_NONE && isPhonehomeVendorUrl(input)) {
    throw new Error(`phonehome: none — refusing request to ${new URL(String(input)).hostname}`);
  }
}
