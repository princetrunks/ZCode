/**
 * Sando build switch `phonehome` (RD-2828, 2026-10-29).
 *
 * "none" (the fork default) removes every vendor call-home path: the zcode.z.ai remote Built-in
 * catalogue / client-config fetches, the device ID (telemetry-state.json), OTEL exporters, update
 * checks, and the Z.ai / BigModel login + endpoint defaults. Bundlers replace `__SANDO_PHONEHOME__`
 * (CLI esbuild, server/web builds), so every gate is a build-time constant and the gated paths are
 * unreachable; unbundled code (tsc, tests) falls back to "none" as well. Build with
 * `SANDO_PHONEHOME=upstream` only to reproduce upstream behaviour.
 */
import { PHONEHOME_DISABLED_ORIGIN, PHONEHOME_NONE } from "./zcodeEndpoint.js";

// The switch itself lives in zcodeEndpoint.ts (Node loads that file directly from vite/tsup configs).
export { PHONEHOME_DISABLED_ORIGIN, PHONEHOME_NONE };

export const SANDO_PHONEHOME: "none" | "upstream" = PHONEHOME_NONE ? "none" : "upstream";

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
