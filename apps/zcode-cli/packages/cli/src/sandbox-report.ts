// Sando --sandbox: the `sandbox` field of the headless JSON (SANDO-OS-SANDBOX.md). Absent when the sandbox is off.
import { selectOsSandbox } from "@zcode/adapters/exec";
import { osSandboxSettingFromEnv, osSandboxWidenFromEnv } from "@zcode/core";

export type SandboxReport = {
  mode: "workspace-write" | "read-only";
  runner: "bwrap" | "landlock" | "none";
  enforcement: "full" | "partial" | "none";
  landlockAbi?: number;
  widen: "none" | "one-call" | "unconfined";
};

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
        ? { mode, runner: "none", enforcement: "none", widen }
        : {
            mode,
            runner: selection.runner,
            enforcement: selection.enforcement,
            ...(selection.landlockAbi === undefined ? {} : { landlockAbi: selection.landlockAbi }),
            widen,
          },
  };
}
