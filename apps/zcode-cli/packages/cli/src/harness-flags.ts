// Sando: per-run harness flags for headless and TUI runs (Harness² proposal sando-harness-flags, 2026-10-18).
//   --model <provider>/<model>   this run only; nothing written to provider_config.json      → ZCODE_MODEL
//   --harness <dir>              <dir>/AGENTS.md + <dir>/skills + <dir>/agents, outside cwd   → ZCODE_HARNESS_DIR
//   --max-turns <n>              model steps per user turn; the last one answers without tools → ZCODE_MAX_TURNS
//   --confine-to-cwd             file tools refuse paths outside the workspace (+ harness dir) → ZCODE_CONFINE_TO_CWD
// The runtime runs in-process and reads these from the env, so they reach bootstrap, adapters and core tools alike.
import { statSync } from "node:fs";
import { resolve } from "node:path";

export interface SandoRunFlagValues {
  model?: string | boolean;
  harness?: string | boolean;
  "max-turns"?: string | boolean;
  "confine-to-cwd"?: string | boolean;
}

/** Returns the env entries to set, or an error message for a bad value. */
export function resolveSandoRunFlags(
  values: SandoRunFlagValues,
  baseDir: string,
): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  if (typeof values.model === "string") {
    const model = values.model.trim();
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) {
      return { error: `--model expects <provider>/<model>, got "${values.model}"` };
    }
    env.ZCODE_MODEL = model;
  }
  if (typeof values.harness === "string") {
    const dir = resolve(baseDir, values.harness);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return { error: `--harness: not a directory: ${dir}` };
    env.ZCODE_HARNESS_DIR = dir;
  }
  if (typeof values["max-turns"] === "string") {
    const raw = values["max-turns"].trim();
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1) {
      return { error: `--max-turns expects a positive whole number, got "${values["max-turns"]}"` };
    }
    env.ZCODE_MAX_TURNS = String(n);
  }
  if (values["confine-to-cwd"] === true) env.ZCODE_CONFINE_TO_CWD = "1";
  return { env };
}
