// Sando: per-run harness flags for headless and TUI runs (Harness² proposal sando-harness-flags, 2026-10-18).
//   --model <provider>/<model>   this run only; nothing written to provider_config.json      → ZCODE_MODEL
//   --harness <dir>              <dir>/AGENTS.md + <dir>/skills + <dir>/agents, outside cwd   → ZCODE_HARNESS_DIR
//   --max-turns <n>              model steps per user turn; the last one answers without tools → ZCODE_MAX_TURNS
//   --confine-to-cwd             file tools refuse paths outside the workspace (+ harness dir) → ZCODE_CONFINE_TO_CWD
//   --deny-commands <json file>  Bash commands matching a pattern are refused before they run → SANDO_DENY_COMMANDS (JSON)
//                                (core/tool/handlers/bash-deny-list.ts; read and checked once, here)
//   --sandbox <mode>             Bash runs in the OS sandbox: workspace-write | read-only | off  → SANDO_SANDBOX
//   --sandbox-widen <w>          one-call (one unsandboxed Bash call) | unconfined (run without a usable sandbox)
//                                                                                              → SANDO_SANDBOX_WIDEN
//                                (core/tool/os-sandbox-policy.ts, adapters/exec/os-sandbox.ts; SANDO-OS-SANDBOX.md)
// The runtime runs in-process and reads these from the env, so they reach bootstrap, adapters and core tools alike.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  DENY_COMMANDS_ENV,
  osSandboxSettingFromEnv,
  osSandboxWidenFromEnv,
  readDenyListFile,
  SANDBOX_ENV,
  SANDBOX_WIDEN_ENV,
} from "@zcode/core";

export interface SandoRunFlagValues {
  model?: string | boolean;
  harness?: string | boolean;
  "max-turns"?: string | boolean;
  "confine-to-cwd"?: string | boolean;
  "deny-commands"?: string | boolean;
  sandbox?: string | boolean;
  "sandbox-widen"?: string | boolean;
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
  if (typeof values["deny-commands"] === "string") {
    const file = resolve(baseDir, values["deny-commands"]);
    try {
      env[DENY_COMMANDS_ENV] = JSON.stringify(readDenyListFile(file));
    } catch (error) {
      return { error: `--deny-commands: ${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  for (const [flag, key, parse] of [
    ["sandbox", SANDBOX_ENV, osSandboxSettingFromEnv],
    ["sandbox-widen", SANDBOX_WIDEN_ENV, osSandboxWidenFromEnv],
  ] as const) {
    const value = values[flag];
    if (typeof value !== "string") continue;
    try {
      parse({ [key]: value });
    } catch (error) {
      return { error: `--${flag}: ${error instanceof Error ? error.message : String(error)}` };
    }
    env[key] = value.trim();
  }
  return { env };
}
