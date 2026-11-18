import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { McpServerConfig, RuntimeConfigPatch } from "@zcode/contracts";
import {
  createWorkspaceHookSourceInput,
  discoverWorkspaceHookConfigPaths,
  workspaceHooksConfigSchema,
  type WorkspaceHookSourceInput,
} from "@zcode/shared/workspace-hook-discovery";
import { loadFileConfig, type LoadedConfig } from "./file-config.adapter.js";

const CURRENT_DIRECTORY = ".";

export interface ProjectConfigFile {
  baseDir: string;
  config: RuntimeConfigPatch;
  diagnostics: LoadedConfig["diagnostics"];
  hookCandidate?: WorkspaceHookSourceInput;
  loaded: boolean;
  path: string;
}

export interface ProjectConfigDiscovery {
  files: ProjectConfigFile[];
  diagnostics: LoadedConfig["diagnostics"];
  hookCandidates: WorkspaceHookSourceInput[];
  loaded: boolean;
  paths: string[];
  mcpServerNames: string[];
}

export function loadProjectConfigs(
  workingDirectory?: string,
  explicitProjectConfigPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectConfigDiscovery {
  const resolvedWorkingDirectory = resolve(workingDirectory ?? process.cwd());
  const refs = discoverWorkspaceHookConfigPaths({
    workingDirectory: resolvedWorkingDirectory,
    ...(explicitProjectConfigPath ? { explicitProjectConfigPath } : {}),
  });
  if (sandboxIgnoresProjectConfig(env)) {
    return {
      ...summarizeProjectConfigs([]),
      diagnostics: refs.map((ref) => ({
        code: "config_project_ignored_by_sandbox",
        filePath: ref.path,
        message: PROJECT_CONFIG_IGNORED_BY_SANDBOX,
        path: "",
        severity: "warning" as const,
      })),
    };
  }
  const files = refs.map((ref, discoveryOrder) =>
    loadProjectConfigFile(ref.path, {
      discoveryOrder,
      explicitProjectConfig: ref.explicitProjectConfig,
      workingDirectory: resolvedWorkingDirectory,
    }),
  );

  return summarizeProjectConfigs(files);
}

// Sando --sandbox (SANDO-OS-SANDBOX.md): a workspace .zcode/config.json or zcode.json is not read at all. Its keys act in
// Sando's own process, outside the OS sandbox: mcp.servers (a stdio server runs unconfined), plugins.dirs (plugin hooks
// and MCP), network.httpProxy (every provider request, the whole conversation, through a proxy the repo names),
// storage.dir (Sando writes outside the workspace). Fails closed like core's isOsSandboxOn: any value but off = on.
export const PROJECT_CONFIG_IGNORED_BY_SANDBOX =
  "Project config ignored: --sandbox does not read workspace .zcode/config.json or zcode.json (its MCP servers, plugins, proxy and storage would act outside the OS sandbox)";

export function sandboxIgnoresProjectConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SANDO_SANDBOX?.trim().toLowerCase();
  return Boolean(value) && value !== "off" && value !== "none";
}

export function loadProjectConfigFile(
  path: string,
  options: {
    discoveryOrder?: number;
    explicitProjectConfig?: boolean;
    workingDirectory?: string;
  } = {},
): ProjectConfigFile {
  const result = loadFileConfig(path);
  const baseDir = getProjectConfigBaseDir(result.path);
  const diagnostics = [...result.diagnostics];
  const hooks = result.loaded ? result.config.hooks : undefined;

  if (hooks) {
    diagnostics.push({
      code: "config_project_hooks_pending_trust",
      filePath: result.path,
      message: "Project hooks are pending workspace trust and remain blocked",
      path: "hooks",
      severity: "warning",
    });
  }

  return {
    baseDir,
    config: result.loaded ? normalizeProjectConfig(result.config, baseDir) : {},
    diagnostics,
    ...(hooks
      ? {
          hookCandidate: createWorkspaceHookSourceInput({
            path: result.path,
            workingDirectory: resolve(options.workingDirectory ?? baseDir),
            // hooks 字段已由 loadFileConfig 经 ZCodeConfigFileSchema（shared 单源
            // schema）完成运行时校验；这里的 parse 仅做类型桥接——HooksRuntimeConfigPatch
            // 与 WorkspaceHooksConfig 是两个领域类型（执行 side vs 配置 side，字段语义有
            // 微差），不共享 TS 结构。禁止改成 as 断言绕过校验。
            hooks: workspaceHooksConfigSchema.parse(hooks),
            discoveryOrder: options.discoveryOrder ?? 0,
            explicitProjectConfig: options.explicitProjectConfig,
          }),
        }
      : {}),
    loaded: result.loaded,
    path: result.path,
  };
}

export function summarizeProjectConfigs(files: ProjectConfigFile[]): ProjectConfigDiscovery {
  const loadedFiles = files.filter((file) => file.loaded);
  const mcpServerNames = new Set<string>();

  for (const file of loadedFiles) {
    for (const name of Object.keys(file.config.mcp?.servers ?? {})) {
      mcpServerNames.add(name);
    }
  }

  return {
    diagnostics: files.flatMap((file) => file.diagnostics),
    files: loadedFiles,
    hookCandidates: loadedFiles.flatMap((file) => (file.hookCandidate ? [file.hookCandidate] : [])),
    loaded: loadedFiles.length > 0,
    paths: loadedFiles.map((file) => file.path),
    mcpServerNames: [...mcpServerNames],
  };
}

function getProjectConfigBaseDir(path: string): string {
  const configDirectory = dirname(path);
  return basename(configDirectory) === ".zcode" ? dirname(configDirectory) : configDirectory;
}

function normalizeProjectConfig(config: RuntimeConfigPatch, baseDir: string): RuntimeConfigPatch {
  const normalized: RuntimeConfigPatch = config.hooks
    ? (() => {
        const { hooks: _hooks, ...safeConfig } = config;
        // Project Hook declarations are retained only in the immutable candidate side-channel.
        // The executable RuntimeConfigPatch remains hook-free until a later admission phase.
        return safeConfig;
      })()
    : { ...config };

  if (!normalized.mcp?.servers) return normalized;

  return {
    ...normalized,
    mcp: {
      ...normalized.mcp,
      servers: Object.fromEntries(
        Object.entries(normalized.mcp.servers).map(([name, server]) => [
          name,
          normalizeProjectMcpServer(server, baseDir),
        ]),
      ),
    },
  };
}

function normalizeProjectMcpServer(server: McpServerConfig, baseDir: string): McpServerConfig {
  if (server.type !== "stdio") return server;

  const cwd = server.cwd ?? CURRENT_DIRECTORY;
  return {
    ...server,
    cwd: isAbsolute(cwd) ? cwd : resolve(baseDir, cwd),
  };
}
