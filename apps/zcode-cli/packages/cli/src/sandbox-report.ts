// Sando --sandbox: the `sandbox` field of the headless JSON (SANDO-OS-SANDBOX.md). Absent when the sandbox is off.
import { selectOsSandbox } from "@zcode/adapters/exec";
import { osSandboxSettingFromEnv, osSandboxWidenFromEnv } from "@zcode/core";

export type SandboxReport = {
  mode: "workspace-write" | "read-only";
  runner: "bwrap" | "landlock" | "none";
  enforcement: "full" | "partial" | "none";
  landlockAbi?: number;
  widen: "none" | "one-call" | "unconfined";
  // What else --sandbox switches off, so a launcher can require it (an older build does not report these):
  // no MCP server started, no workspace .zcode/config.json / zcode.json read.
  mcp: "off";
  projectConfig: "ignored";
};

const LOCKDOWN = { mcp: "off", projectConfig: "ignored" } as const;

export function sandboxReportFields(env: NodeJS.ProcessEnv = process.env): {
  sandbox?: SandboxReport;
} {
  let mode;
  let widen;
  try {
    mode = osSandboxSettingFromEnv(env);
    widen = osSandboxWidenFromEnv(env);
  } catch {
    return {};
  }
  if (mode === "off") return {};
  const selection = selectOsSandbox();
  return {
    sandbox:
      selection.runner === "none"
        ? { mode, runner: "none", enforcement: "none", widen, ...LOCKDOWN }
        : {
            mode,
            runner: selection.runner,
            enforcement: selection.enforcement,
            ...(selection.landlockAbi === undefined ? {} : { landlockAbi: selection.landlockAbi }),
            widen,
            ...LOCKDOWN,
          },
  };
}
