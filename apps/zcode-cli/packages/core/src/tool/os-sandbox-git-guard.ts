// Sando --sandbox, git guard (SANDO-OS-SANDBOX.md): a sandboxed command may write the workspace's `.git`, and git runs
// programs named in its config and hooks. Sando itself runs git unconfined in the workspace (the context snapshot,
// checkpoints), and so does the user later. So before and after each sandboxed Bash call, the guard compares the
// repo config's program-running keys and the hooks with the last known state:
//   - a config that gained such a key is restored to its previous content (a new config is moved aside);
//   - a new or changed hook is renamed to `<name>.sando-blocked`.
// Plain config changes (user.email, remotes, branches) are left alone. Not covered: other repos nested in the workspace.
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

// Keys whose value git runs as a program (or that pull in another config file that could name one).
const PROGRAM_KEY =
  /^(core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|alternaterefscommand)|sequence\.editor|diff\.external|diff\..+\.(command|textconv)|merge\..+\.driver|filter\..+\.(clean|smudge|process)|credential(\..+)?\.helper|gpg(\..+)?\.program|pager\..+|alias\..+|include\.path|includeif\..+\.path|interactive\.difffilter|man\..+\.(cmd|path)|web\.browser|browser\..+\.(cmd|path)|remote\..+\.(uploadpack|receivepack|vcs)|uploadpack\.packobjectshook|difftool\..+\.(cmd|path)|mergetool\..+\.(cmd|path))$/i;

export interface GitGuardState {
  configs: Record<string, string | null>;
  hooks: Record<string, string>;
}

/** Git dir (where config.worktree and hooks live) and common dir (shared config) of a workspace, if it is a repo root. */
function gitDirs(workspaceRoot: string): { gitDir: string; commonDir: string } | undefined {
  const dotGit = join(workspaceRoot, ".git");
  let gitDir: string;
  try {
    if (statSync(dotGit).isDirectory()) {
      gitDir = dotGit;
    } else {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (!match?.[1]) return undefined;
      gitDir = resolve(workspaceRoot, match[1].trim());
    }
  } catch {
    return undefined;
  }
  let commonDir = gitDir;
  try {
    commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  } catch {
    // not a linked worktree
  }
  return { gitDir, commonDir };
}

/** `section.subsection.key=value` for every program-running entry of one git config file. */
export function programConfigEntries(text: string): string[] {
  const out: string[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[\s*([^\]\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/.exec(line);
    if (header) {
      const [, name = "", sub] = header;
      const dot = name.indexOf(".");
      section =
        sub !== undefined
          ? `${name.toLowerCase()}.${sub}`
          : dot >= 0
            ? `${name.slice(0, dot).toLowerCase()}.${name.slice(dot + 1)}`
            : name.toLowerCase();
      const rest = header[3]?.trim();
      if (!rest) continue;
      const [k = "", ...v] = rest.split("=");
      if (PROGRAM_KEY.test(`${section}.${k.trim().toLowerCase()}`))
        out.push(`${section}.${k.trim().toLowerCase()}=${v.join("=").trim()}`);
      continue;
    }
    const [k = "", ...v] = line.split("=");
    const key = `${section}.${k.trim().toLowerCase()}`;
    if (PROGRAM_KEY.test(key)) out.push(`${key}=${v.join("=").trim()}`);
  }
  return out;
}

export function readGitGuardState(workspaceRoot: string): GitGuardState | undefined {
  const dirs = gitDirs(workspaceRoot);
  if (!dirs) return undefined;
  const configs: Record<string, string | null> = {};
  for (const path of new Set([
    join(dirs.commonDir, "config"),
    join(dirs.gitDir, "config.worktree"),
  ])) {
    try {
      configs[path] = readFileSync(path, "utf8");
    } catch {
      configs[path] = null;
    }
  }
  const hooks: Record<string, string> = {};
  for (const dir of new Set([join(dirs.commonDir, "hooks"), join(dirs.gitDir, "hooks")])) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".sample") || name.endsWith(".sando-blocked")) continue;
      try {
        const st = statSync(join(dir, name));
        if (st.isFile()) hooks[join(dir, name)] = `${st.size}:${st.mtimeMs}:${st.mode}`;
      } catch {
        // gone
      }
    }
  }
  return { configs, hooks };
}

const MINIMAL_CONFIG =
  "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n";

/**
 * Undo what a sandboxed command did to the repo's program-running config and hooks since `before`. Returns one line per
 * thing undone (empty when nothing was), and the state to compare against next time.
 */
export function enforceGitGuard(
  workspaceRoot: string,
  before: GitGuardState | undefined,
): { notes: string[]; state: GitGuardState | undefined } {
  const now = readGitGuardState(workspaceRoot);
  if (!now) return { notes: [], state: undefined };
  const notes: string[] = [];
  for (const [path, text] of Object.entries(now.configs)) {
    if (text === null) continue;
    const old = before?.configs[path] ?? null;
    const known = new Set(programConfigEntries(old ?? ""));
    const added = programConfigEntries(text).filter((entry) => !known.has(entry));
    if (added.length === 0) continue;
    if (old !== null) {
      writeFileSync(path, old);
    } else {
      renameSync(path, `${path}.sando-blocked`);
      if (path.endsWith("/config")) writeFileSync(path, MINIMAL_CONFIG);
    }
    notes.push(`restored ${path} (it gained ${added.map((e) => e.split("=")[0]).join(", ")})`);
  }
  for (const [path, signature] of Object.entries(now.hooks)) {
    if (before?.hooks[path] === signature) continue;
    if (!existsSync(path)) continue;
    renameSync(path, `${path}.sando-blocked`);
    notes.push(`disabled the new hook ${path} (renamed to .sando-blocked)`);
  }
  return { notes, state: notes.length ? readGitGuardState(workspaceRoot) : now };
}

const lastKnown = new Map<string, GitGuardState | undefined>();

export function resetGitGuardForTest(): void {
  lastKnown.clear();
}

/** Call before a sandboxed command: undoes anything a background command did since the last check. */
export function gitGuardBefore(workspaceRoot: string): string[] {
  if (!lastKnown.has(workspaceRoot)) {
    lastKnown.set(workspaceRoot, readGitGuardState(workspaceRoot));
    return [];
  }
  const { notes, state } = enforceGitGuard(workspaceRoot, lastKnown.get(workspaceRoot));
  lastKnown.set(workspaceRoot, state);
  return notes;
}

/** Call after a sandboxed command. */
export function gitGuardAfter(workspaceRoot: string): string[] {
  const { notes, state } = enforceGitGuard(workspaceRoot, lastKnown.get(workspaceRoot));
  lastKnown.set(workspaceRoot, state);
  return notes;
}

/**
 * Sando's own git runs (context snapshot, checkpoints) happen outside the sandbox: turn off fsmonitor for them, which
 * `git status` would otherwise run from the repo config. Appended to GIT_CONFIG_COUNT/KEY_n/VALUE_n (git >= 2.31).
 */
export function applyOsSandboxGitHardening(env: NodeJS.ProcessEnv = process.env): void {
  if (env.SANDO_SANDBOX_GIT_HARDENED === "1") return;
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  env[`GIT_CONFIG_KEY_${count}`] = "core.fsmonitor";
  env[`GIT_CONFIG_VALUE_${count}`] = "false";
  env.GIT_CONFIG_COUNT = String(count + 1);
  env.SANDO_SANDBOX_GIT_HARDENED = "1";
}
