// ============================================================
// Tool Path Policy
// ============================================================

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { CoreErrorType, createCoreError } from "@zcode/contracts";

interface ToolWorkspacePathOptions {
  inputPath: string;
  workingDirectory: string;
  workspaceRoot: string;
  operation: "read" | "write" | "execute";
  /** Sando: harness-internal lookups (memory files, Bash read-state bookkeeping) are not tool access; skip --confine-to-cwd. */
  skipConfinement?: boolean;
}

export function resolveWorkspacePath(options: ToolWorkspacePathOptions): string {
  const workingDirectory = normalizeAbsoluteDirectory(
    options.workingDirectory,
    "workingDirectory",
  );
  normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
  const requestedPath = options.inputPath;

  if (requestedPath.length === 0) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Tool path must not be empty", {
      context: {
        operation: options.operation,
      },
      recoverable: true,
    });
  }

  const resolvedPath = isAbsolute(requestedPath)
    ? normalize(requestedPath)
    : resolve(workingDirectory, requestedPath);

  // Current release intentionally does not hard-block paths outside workspaceRoot.
  // Cause: subagents may need to inspect user-requested sibling repos or external files
  // before the filesystem permission adapter grows explicit ask/deny rules for them.
  // Sando: `--confine-to-cwd` (ZCODE_CONFINE_TO_CWD=1) turns that block on for a run.
  if (!options.skipConfinement && isConfinedToWorkspace()) {
    assertInsideAllowedRoots(resolvedPath, options);
  }
  return resolvedPath;
}

// ============================================================
// Sando: --confine-to-cwd
// ============================================================
// Read / Write / Edit / Grep / Glob paths (and the Bash working directory) must resolve inside the workspace root,
// or inside the --harness dir when one is set. Symlinks are resolved first, so a link inside the workspace cannot
// point the tool outside it. Not covered: what a Bash command or the node REPL does once running (use the shell
// gate / permission mode for those), and MCP / web tools.

export const CONFINE_TO_CWD_ENV = "ZCODE_CONFINE_TO_CWD";

export function isConfinedToWorkspace(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CONFINE_TO_CWD_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** Real path of `target`, resolving symlinks through the deepest ancestor that exists (the file may not exist yet). */
function realpathOfNearestExisting(target: string): string {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return rest.length ? resolve(real, ...rest.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return target;
      rest.push(relative(parent, current));
      current = parent;
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function confinementRoots(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots = [workspaceRoot];
  const harnessDir = env.ZCODE_HARNESS_DIR?.trim();
  if (harnessDir && isAbsolute(harnessDir)) roots.push(harnessDir);
  return roots.map((root) => realpathOfNearestExisting(normalize(root)));
}

/** True when confinement is off, or `target` (symlinks resolved) is inside the workspace / harness roots. */
export function isPathAllowedByConfinement(
  target: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isConfinedToWorkspace(env)) return true;
  const roots = confinementRoots(workspaceRoot, env);
  const real = realpathOfNearestExisting(normalize(target));
  return roots.some((root) => isWithin(root, real));
}

function assertInsideAllowedRoots(resolvedPath: string, options: ToolWorkspacePathOptions): void {
  const roots = confinementRoots(options.workspaceRoot);
  const real = realpathOfNearestExisting(resolvedPath);
  if (roots.some((root) => isWithin(root, real))) return;
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `Path is outside the workspace (${options.workspaceRoot}) and this run is confined to it (--confine-to-cwd): ${options.inputPath}`,
    {
      context: {
        operation: options.operation,
        path: resolvedPath,
        workspaceRoot: options.workspaceRoot,
      },
      recoverable: true,
    },
  );
}

export function resolveToolWorkingDirectory(
  inputCwd: string | undefined,
  options: Omit<ToolWorkspacePathOptions, "inputPath">,
): string {
  if (!inputCwd) {
    const workingDirectory = normalizeAbsoluteDirectory(
      options.workingDirectory,
      "workingDirectory",
    );
    normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
    return workingDirectory;
  }

  return resolveWorkspacePath({
    ...options,
    inputPath: inputCwd,
  });
}

function normalizeAbsoluteDirectory(value: string, label: string): string {
  const normalized = normalize(value);
  if (!isAbsolute(normalized)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `${label} must be an absolute path for tool execution`,
      {
        context: {
          [label]: value,
        },
        recoverable: false,
      },
    );
  }
  return normalized;
}
