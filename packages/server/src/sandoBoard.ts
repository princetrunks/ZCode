// Sando board (2026-11-03): the web workbench's "Board" side pane shows a Project Planner chat's status board.
// The browser never sees the Planner credential: these routes run on the Sando web server (behind the lite-token cookie)
// and call the Planner REST API with the token the shrinetech-planner plugin already uses for MCP.
//
//   POST /api/sando/board/ensure  {workspace, session?}  -> resolve (session pick > workspace pick > the Planner chat
//        linked to the workspace's project) or create "Sando · <project>" with a seed board; persists the workspace pick
//   POST /api/sando/board/pick    {workspace, session?, chatId, scope: "session"|"workspace"}
//   GET  /api/sando/board/status?chat=<id>   -> {status} (the pane polls this; cheap, ≤20k chars)
//   GET  /api/sando/board/chats              -> recent Planner chats for the picker
//
// The pick is written to ~/.zcode/v2/sando-boards.json; the agent runtime reads the same file and tells the model which
// chat to keep current (apps/zcode-cli/packages/core/src/runtime/helpers/sando-board.ts).
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BoardBinding {
  chatId: number;
  title?: string;
}

interface BoardsFile {
  version: 1;
  workspaces: Record<string, BoardBinding>;
  sessions: Record<string, BoardBinding>;
}

export interface PlannerCredentials {
  baseUrl: string;
  authorization: string;
}

export interface SandoBoardOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetchImpl?: typeof fetch;
  /** git common dir lookup for worktrees; injectable for tests. */
  gitCommonDir?: (cwd: string) => Promise<string | null>;
}

export interface PlannerChat {
  id: number;
  title: string;
  scope_project_ids?: string | null;
  status_updated_at?: string | null;
  updated_at?: string | null;
}

export interface PlannerProject {
  id: number;
  name: string;
  local_path?: string | null;
  execution_cwd?: string | null;
}

export interface BoardStatus {
  chat_id: number;
  markdown: string;
  url: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

const MAX_CHAT_ID = 2 ** 31 - 1;
const PLANNER_TIMEOUT_MS = 8_000;

export function parseChatId(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isInteger(n) && n > 0 && n <= MAX_CHAT_ID ? n : null;
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/[/\\]+$/u, "") : p);

export function normalizeWorkspace(raw: unknown, home: string): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.length > 4096 || t.includes("\0")) return null;
  const expanded = t === "~" ? home : t.startsWith("~/") ? join(home, t.slice(2)) : t;
  if (!expanded.startsWith("/")) return null;
  return trimSlash(resolve(expanded));
}

const looseName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/gu, "");

/**
 * Which Planner project is this workspace? Exact path first (local_path / execution_cwd, `~` expanded), then the folder
 * name (the Planner keeps Mac paths for most projects, the forge checkout has the same folder name), then the project
 * name. `candidates` lists the workspace and, for a git worktree, the main checkout.
 */
export function matchProject(
  projects: readonly PlannerProject[],
  candidates: readonly string[],
  home: string,
): PlannerProject | null {
  const paths = (p: PlannerProject) =>
    [p.local_path, p.execution_cwd]
      .filter((x): x is string => typeof x === "string" && x.trim() !== "")
      .map((x) => normalizeWorkspace(x, home))
      .filter((x): x is string => x !== null);
  for (const c of candidates) {
    const hit = projects.find((p) => paths(p).includes(c));
    if (hit) return hit;
  }
  for (const c of candidates) {
    const name = looseName(basename(c));
    if (!name) continue;
    const hit = projects.find((p) => paths(p).some((x) => looseName(basename(x)) === name));
    if (hit) return hit;
  }
  for (const c of candidates) {
    const name = looseName(basename(c));
    if (!name) continue;
    const hit = projects.find((p) => looseName(p.name) === name);
    if (hit) return hit;
  }
  return null;
}

function scopeIds(chat: PlannerChat): number[] {
  try {
    const ids: unknown = JSON.parse(chat.scope_project_ids || "[]");
    return Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

/** The project's chat: one that already has a board wins, then the most recently active (list is newest first). */
export function pickLinkedChat(
  chats: readonly PlannerChat[],
  projectId: number,
): PlannerChat | null {
  const linked = chats.filter((c) => scopeIds(c).includes(projectId));
  return linked.find((c) => c.status_updated_at) ?? linked[0] ?? null;
}

export function seedBoard(title: string, workspace: string): string {
  return [
    `**${title}** · Sando workbench board for \`${workspace}\`. The session's model keeps it current (one section per update).`,
    "",
    "## Running now",
    "- (nothing yet)",
    "",
    "## Done",
    "",
    "## Waiting on you",
    "- (nothing)",
    "",
  ].join("\n");
}

export function resolveBoardsFilePath(env: NodeJS.ProcessEnv, home: string): string {
  return env.SANDO_BOARDS_FILE?.trim() || join(home, ".zcode", "v2", "sando-boards.json");
}

async function readBoards(path: string): Promise<BoardsFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<BoardsFile>;
    return {
      version: 1,
      workspaces:
        parsed.workspaces && typeof parsed.workspaces === "object" ? parsed.workspaces : {},
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    };
  } catch {
    return { version: 1, workspaces: {}, sessions: {} };
  }
}

// One writer per process; the runtime only reads. Writes are serialised and atomic (tmp + rename).
let writeChain: Promise<unknown> = Promise.resolve();
function updateBoards(path: string, mutate: (f: BoardsFile) => void): Promise<void> {
  const run = writeChain.then(async () => {
    const data = await readBoards(path);
    mutate(data);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  });
  writeChain = run.catch(() => undefined);
  return run;
}

/**
 * The Planner endpoint + token. SANDO_PLANNER_URL / SANDO_PLANNER_TOKEN win; otherwise the shrinetech-planner plugin's
 * mcp.json (the "existing token path": plugins.dirs in ~/.zcode/cli/config.json). Never logged, never sent to the browser.
 */
export async function resolvePlannerCredentials(
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<PlannerCredentials | null> {
  const envUrl = env.SANDO_PLANNER_URL?.trim();
  const envToken = env.SANDO_PLANNER_TOKEN?.trim();
  if (envUrl && envToken) {
    return {
      baseUrl: trimSlash(envUrl),
      authorization: /^bearer /iu.test(envToken) ? envToken : `Bearer ${envToken}`,
    };
  }
  let dirs: string[] = [];
  try {
    const cfg = JSON.parse(await readFile(join(home, ".zcode", "cli", "config.json"), "utf8")) as {
      plugins?: { dirs?: unknown };
    };
    if (Array.isArray(cfg.plugins?.dirs))
      dirs = cfg.plugins.dirs.filter((d): d is string => typeof d === "string");
  } catch {
    return null;
  }
  for (const dir of dirs) {
    try {
      const mcp = JSON.parse(await readFile(join(dir, "mcp.json"), "utf8")) as {
        mcpServers?: Record<string, { url?: unknown; headers?: Record<string, unknown> }>;
      };
      for (const server of Object.values(mcp.mcpServers ?? {})) {
        const url = typeof server.url === "string" ? server.url : "";
        const auth = server.headers?.Authorization ?? server.headers?.authorization;
        if (/\/mcp\/?$/u.test(url) && typeof auth === "string" && auth.trim()) {
          return { baseUrl: url.replace(/\/mcp\/?$/u, ""), authorization: auth.trim() };
        }
      }
    } catch {
      // not this plugin
    }
  }
  return null;
}

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function defaultGitCommonDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd,
        timeout: 3_000,
      },
    );
    const dir = stdout.trim();
    return dir.endsWith("/.git") ? dir.slice(0, -5) : null;
  } catch {
    return null;
  }
}

export function createSandoBoardService(options: SandoBoardOptions = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const doFetch = options.fetchImpl ?? fetch;
  const gitCommonDir = options.gitCommonDir ?? defaultGitCommonDir;
  const boardsPath = resolveBoardsFilePath(env, home);
  const publicUrl = trimSlash(
    env.SANDO_PLANNER_PUBLIC_URL?.trim() || "https://projects.shrinetech.io",
  );

  async function planner<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const creds = await resolvePlannerCredentials(env, home);
    if (!creds)
      throw new PlannerError("Planner is not configured (no shrinetech-planner plugin token)", 503);
    let res: Response;
    try {
      res = await doFetch(`${creds.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: creds.authorization,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(PLANNER_TIMEOUT_MS),
      });
    } catch (err) {
      throw new PlannerError(
        `Planner unreachable: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }
    if (!res.ok)
      throw new PlannerError(`Planner answered ${res.status}`, res.status === 404 ? 404 : 502);
    return (await res.json()) as T;
  }

  const chatLink = (chatId: number) => `${publicUrl}/chat/s/${chatId}`;

  async function getStatus(chatId: number): Promise<BoardStatus> {
    const r = await planner<{ status: BoardStatus }>(`/api/chat/sessions/${chatId}/status`);
    return r.status;
  }

  async function listChats(): Promise<PlannerChat[]> {
    const r = await planner<{ sessions?: PlannerChat[] }>("/api/chat/sessions");
    return Array.isArray(r.sessions) ? r.sessions : [];
  }

  async function ensure(input: { workspace: string; session?: string | null }) {
    const boards = await readBoards(boardsPath);
    const sessionPick = input.session ? boards.sessions[input.session] : undefined;
    if (sessionPick && parseChatId(sessionPick.chatId)) {
      return {
        binding: sessionPick,
        source: "session" as const,
        status: await getStatus(sessionPick.chatId),
      };
    }
    const workspacePick = boards.workspaces[input.workspace];
    if (workspacePick && parseChatId(workspacePick.chatId)) {
      return {
        binding: workspacePick,
        source: "workspace" as const,
        status: await getStatus(workspacePick.chatId),
      };
    }

    const candidates = [input.workspace];
    const main = await gitCommonDir(input.workspace);
    if (main && main !== input.workspace) candidates.push(main);
    const projects =
      (await planner<PlannerProject[] | { projects?: PlannerProject[] }>("/api/projects")) ?? [];
    const projectList = Array.isArray(projects) ? projects : (projects.projects ?? []);
    const project = matchProject(projectList, candidates, home);

    let binding: BoardBinding;
    let source: "project" | "created";
    const linked = project ? pickLinkedChat(await listChats(), project.id) : null;
    if (linked) {
      binding = { chatId: linked.id, title: linked.title };
      source = "project";
    } else {
      const title = `Sando · ${project?.name ?? basename(input.workspace)}`;
      const created = await planner<{ session: { id: number; title: string } }>(
        "/api/chat/sessions",
        {
          method: "POST",
          body: project
            ? { title, scope_kind: "project", scope_project_ids: [project.id] }
            : { title },
        },
      );
      binding = { chatId: created.session.id, title: created.session.title || title };
      source = "created";
      await planner(`/api/chat/sessions/${binding.chatId}/status`, {
        method: "PUT",
        body: {
          markdown: seedBoard(binding.title ?? title, input.workspace),
          url: chatLink(binding.chatId),
        },
      });
    }
    await updateBoards(boardsPath, (f) => {
      f.workspaces[input.workspace] = binding;
    });
    return { binding, source, status: await getStatus(binding.chatId) };
  }

  async function pick(input: {
    workspace: string;
    session?: string | null;
    chatId: number;
    scope: "session" | "workspace";
  }) {
    const status = await getStatus(input.chatId);
    const chats = await listChats();
    const title = chats.find((c) => c.id === input.chatId)?.title;
    const binding: BoardBinding = title
      ? { chatId: input.chatId, title }
      : { chatId: input.chatId };
    await updateBoards(boardsPath, (f) => {
      if (input.scope === "session" && input.session) f.sessions[input.session] = binding;
      else {
        f.workspaces[input.workspace] = binding;
        if (input.session) delete f.sessions[input.session];
      }
    });
    return {
      binding,
      source: input.scope === "session" && input.session ? "session" : "workspace",
      status,
    };
  }

  return { ensure, pick, getStatus, listChats, chatLink, boardsPath };
}
