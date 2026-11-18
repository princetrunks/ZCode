// Sando --sandbox (SANDO-OS-SANDBOX.md, SAN-4472 port 3): the run-level OS sandbox policy for tool calls.
//   SANDO_SANDBOX=off (default) | workspace-write | read-only
//   SANDO_SANDBOX_WIDEN=one-call | unconfined (unset = none)
// The adapter (adapters/src/exec/os-sandbox.ts) does the confining; this file decides what each call gets:
//   - Bash runs confined (request.sandbox.os). With no usable runner it fails closed unless widen=unconfined.
//   - The one approved widening: with widen=one-call, the first Bash call per session that sets
//     dangerouslyDisableSandbox runs unconfined; any other such call is refused. Never asks; headless-safe.
//   - The js REPL tool runs inside Sando's own process, which the OS sandbox cannot reach, so it is refused.
//   - The file tools get --confine-to-cwd (path-policy.ts isConfinedToWorkspace).

export const SANDBOX_ENV = "SANDO_SANDBOX";
export const SANDBOX_WIDEN_ENV = "SANDO_SANDBOX_WIDEN";

export type OsSandboxSetting = "off" | "workspace-write" | "read-only";
export type OsSandboxWiden = "none" | "one-call" | "unconfined";

export function osSandboxSettingFromEnv(env: NodeJS.ProcessEnv = process.env): OsSandboxSetting {
  const value = env[SANDBOX_ENV]?.trim().toLowerCase();
  if (!value || value === "off" || value === "none") return "off";
  if (value === "workspace-write" || value === "on") return "workspace-write";
  if (value === "read-only") return "read-only";
  throw new Error(
    `${SANDBOX_ENV} expects off, workspace-write or read-only, got "${env[SANDBOX_ENV]}"`,
  );
}

export function osSandboxWidenFromEnv(env: NodeJS.ProcessEnv = process.env): OsSandboxWiden {
  const value = env[SANDBOX_WIDEN_ENV]?.trim().toLowerCase();
  if (!value || value === "none") return "none";
  if (value === "one-call" || value === "unconfined") return value;
  throw new Error(
    `${SANDBOX_WIDEN_ENV} expects one-call or unconfined, got "${env[SANDBOX_WIDEN_ENV]}"`,
  );
}

/** Fail closed: a bad value counts as on, so the tools refuse instead of running unconfined. */
export function isOsSandboxOn(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return osSandboxSettingFromEnv(env) !== "off";
  } catch {
    return true;
  }
}

const IN_PROCESS_CODE_TOOLS = new Set(["js"]);

/** Refusal for tools the OS sandbox cannot confine, or null. */
export function osSandboxToolRefusal(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!IN_PROCESS_CODE_TOOLS.has(toolName) || !isOsSandboxOn(env)) return null;
  return `Refused (--sandbox): the ${toolName} tool runs inside Sando's own process, outside the OS sandbox, so it is off in this run. Use Bash.`;
}

const widenedSessions = new Set<string>();

export function resetOsSandboxWideningForTest(): void {
  widenedSessions.clear();
}

export type OsSandboxBashDecision =
  | { kind: "unsandboxed" }
  | {
      kind: "confined";
      os: {
        mode: "workspace-write" | "read-only";
        workspaceRoot: string;
        allowUnconfined?: boolean;
      };
    }
  | { kind: "widened" }
  | { kind: "refused"; message: string };

/** What one Bash call gets. Call it once per execution: it spends the one-call widening. */
export function decideOsSandboxForBash(
  input: { dangerouslyDisableSandbox?: boolean },
  context: { workspaceRoot?: string; workingDirectory: string; sessionId?: string },
  env: NodeJS.ProcessEnv = process.env,
): OsSandboxBashDecision {
  let setting: OsSandboxSetting;
  let widen: OsSandboxWiden;
  try {
    setting = osSandboxSettingFromEnv(env);
    widen = osSandboxWidenFromEnv(env);
  } catch (error) {
    return {
      kind: "refused",
      message: `Refused (--sandbox): ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
  if (setting === "off") return { kind: "unsandboxed" };
  if (input.dangerouslyDisableSandbox === true) {
    const session = context.sessionId ?? "";
    if (widen === "one-call" && !widenedSessions.has(session)) {
      widenedSessions.add(session);
      return { kind: "widened" };
    }
    return {
      kind: "refused",
      message:
        widen === "one-call"
          ? "Refused (--sandbox): the one approved unsandboxed command for this run was already used. Run it inside the sandbox, or say in your summary what needs to run outside it."
          : "Refused (--sandbox): running outside the sandbox (dangerouslyDisableSandbox) was not approved for this run. Run the command inside the sandbox, or say in your summary what needs to run outside it.",
    };
  }
  return {
    kind: "confined",
    os: {
      mode: setting,
      workspaceRoot: context.workspaceRoot ?? context.workingDirectory,
      ...(widen === "unconfined" ? { allowUnconfined: true } : {}),
    },
  };
}

const DENIAL_PATTERN =
  /permission denied|operation not permitted|read-only file system|could not resolve host|couldn't connect|network is unreachable|sando-confine:/i;

/** A one-line note for a failed confined command whose output looks like a sandbox denial, so the model stops retrying. */
export function osSandboxDenialNote(
  mode: "workspace-write" | "read-only",
  result: { exitCode?: number; status: string; stdout: { text: string }; stderr: { text: string } },
): string | undefined {
  if (result.status === "completed" && (result.exitCode ?? 0) === 0) return undefined;
  if (!DENIAL_PATTERN.test(`${result.stderr.text}\n${result.stdout.text}`)) return undefined;
  const writable = mode === "workspace-write" ? "the workspace and $TMPDIR are" : "only $TMPDIR is";
  return `[Sando sandbox (${mode}): ${writable} writable; the network, /tmp and ~ (except toolchains) are blocked. A denial here is the sandbox, not a bug: do not retry variants of it.]`;
}
