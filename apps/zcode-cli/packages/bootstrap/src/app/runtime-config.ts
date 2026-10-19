import type { ConfigResult } from "@zcode/adapters/config";
import {
  completeNewModelSelection,
  resolveInitialModelSelection,
  type ModelSelection,
  type ModelSelectionOptions,
} from "@zcode/provider";
import { resolveBashTimeoutPolicy, type AgentProfile, type AgentRuntimeConfig } from "@zcode/core";
import { type BuiltInSubagentModelSelectionOverrides } from "@zcode/shared";
import {
  type CollaborationMode,
  type HookConfigSource,
  type HookEventName,
  type HookMatcherConfig,
  type HooksRuntimeConfig,
  type McpServerConfig,
} from "@zcode/contracts";
import { omitMcpServers, resolveTrustedOfficialCuaServerNames } from "../mcp-config.js";
import { resolveDefaultEmbeddedSearchBackend } from "./embedded-search-backend.js";
import { getProjectMemoryRoot } from "./paths.js";
import type { ZCodeAppOptions } from "./types.js";
import {
  createRegistrySelectionProtocolError,
  parseProviderQualifiedModelSelection,
  resolveRegistryOwnedModelSelection,
  resolveRegistryModelSelection,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";

interface ResolvedAppRuntimeConfig {
  configuredMcpServers: Record<string, McpServerConfig>;
  runtimeConfig: AgentRuntimeConfig;
  untrustedProjectMcpServers: Set<string>;
}

interface ResolvedInitialRegistrySelection extends ResolvedRegistrySelection {
  readonly selectionOptions?: ModelSelectionOptions;
}

export function resolveAppRuntimeConfig(input: {
  cliStorageRoot: string;
  configResult: ConfigResult;
  options: ZCodeAppOptions;
  persistedMode?: CollaborationMode;
  builtInMcpServers?: Record<string, McpServerConfig>;
  builtInSubagentModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  pluginHooks?: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  pluginMcpServers?: Record<string, McpServerConfig>;
  pluginRuntimeFeatures?: AgentRuntimeConfig["runtimeFeatures"];
  subagentOutputRootDir: string;
  subagentProfiles?: readonly AgentProfile[];
  storageRoot?: string;
  workingDirectory: string;
  workspaceIdentity?: string;
}): ResolvedAppRuntimeConfig {
  const {
    cliStorageRoot,
    configResult,
    options,
    persistedMode,
    builtInMcpServers,
    pluginMcpServers,
    pluginRuntimeFeatures,
    subagentOutputRootDir,
    subagentProfiles = [],
    workingDirectory,
    workspaceIdentity,
  } = input;
  const userInstructions = options.runtimeConfig?.userInstructions ?? { workingDirectory };
  const registrySelection = resolveInitialRegistrySelection(options);
  // 恢复历史不等于开始执行：失效/缺失选择保持未绑定，不能借 configured default 补齐。
  const initialModelSelection = options.resume
    ? registrySelection?.selection
    : (options.runtimeConfig?.modelSelection ?? registrySelection?.selection);
  // 空白会话先创建、再应用本次 Submission 的选择；强制初始默认模型会
  // 让未配置 default 的用户在 switch/send 前就创建失败。未绑定 Runtime 可以存在，
  // 真正执行仍由 admission/ModelFactory 校验完整选择，不能在这里偷偷选择 Registry 首项。
  const requestedTitleGeneration = options.runtimeConfig?.titleGeneration;
  const requestedTitleModelSelection = requestedTitleGeneration?.modelSelection;
  const titleGeneration =
    requestedTitleGeneration === undefined
      ? undefined
      : {
          ...requestedTitleGeneration,
          // 标题生成 sidecar 默认 15s 在慢模型/代理链路下容易超时，
          // 入口层统一补 60s，避免旧 core 默认值或空配置让桌面端继续回落到 15s。
          timeoutMs: requestedTitleGeneration.timeoutMs ?? 60_000,
          // 空 titleGeneration 表示启用默认标题生成，模型必须跟随会话当前模型。
          // 如果这里在草稿 session 创建时固化另一份标题模型，之后切模型只会更新主链路，
          // 首发时的 generate title sidecar 会继续使用切换前的旧 provider/model。
          ...(requestedTitleModelSelection
            ? {
                modelSelection: requestedTitleModelSelection,
              }
            : {}),
        };
  // Protocol session/create 传入的 mcp.servers 只包含 UI MCP 设置里的用户配置，
  // 不包含插件注册的 MCP。宿主内建 server 最后合并并保留其 identity，避免用户或第三方
  // 用同名配置劫持 mcp__node_repl__*；普通 plugin MCP 仍允许显式用户配置覆盖。
  const configuredMcpServers = {
    ...pluginMcpServers,
    ...(options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers),
    ...builtInMcpServers,
  };
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginMcpServers ?? {},
  );
  const cuaBridgeServerNames = new Set(trustedOfficialCuaServerNames);
  if (pluginRuntimeFeatures?.computerUse === true && configuredMcpServers.node_repl) {
    // node_repl 需要 broker 注入，但不是 CUA MCP server。注入资格与官方 CUA 图片
    // authority 必须分开；把它塞进 trustedOfficialCuaServerNames 会让整个
    // 通用 node_repl 结果被误送进 exact-raster gate，Browser 截图和 console 日志都会失败。
    cuaBridgeServerNames.add("node_repl");
  }
  // 产品决定 workspace MCP 开箱即用：project 作用域 MCP 默认 trusted，并自动连接。
  const untrustedProjectMcpServers = new Set<string>();
  const autoConnectMcpServers = omitMcpServers(
    configuredMcpServers,
    untrustedProjectMcpServers,
    cuaBridgeServerNames,
  );
  const runtimeBuiltInModelSelectionOverrides =
    options.runtimeConfig?.subagents?.builtInModelSelectionOverrides ?? {};
  const runtimeConfig: AgentRuntimeConfig = {
    ...options.runtimeConfig,
    bashTimeoutPolicy:
      options.runtimeConfig?.bashTimeoutPolicy ??
      resolveBashTimeoutPolicy(options.env ?? process.env),
    mode: options.runtimeConfig?.mode ?? persistedMode ?? configResult.config.permission.mode,
    modelSelection: initialModelSelection,
    // Sando `--max-turns` (ZCODE_MAX_TURNS): model steps per user turn for this runtime only.
    ...resolveMaxModelStepsPerTurn(options),
    // 仅接受显式传入的会话级工具面（ZCode Protocol session/create 或 CLI
    // --allowed-tools/--disallowed-tools）。不要从 config.permission.allowedTools
    // 回落：那个键的既有语义是“免审批清单”，把它投影到注册面会让老配置里
    // 只写了几个 allowedTools 的用户突然丢失其余全部工具。
    toolAllowlist: options.runtimeConfig?.toolAllowlist,
    toolDisallowlist: options.runtimeConfig?.toolDisallowlist,
    embeddedSearchBackend:
      options.runtimeConfig?.embeddedSearchBackend ??
      resolveDefaultEmbeddedSearchBackend({
        env: options.env,
      }),
    runtimeFeatures: pluginRuntimeFeatures,
    language: options.runtimeConfig?.language,
    titleGeneration,
    workingDirectory,
    userInstructions: {
      ...userInstructions,
      workingDirectory: userInstructions.workingDirectory ?? workingDirectory,
    },
    skillMetadataBudget:
      options.runtimeConfig?.skillMetadataBudget ?? configResult.config.skills.metadataBudget,
    toolConcurrency: {
      maxConcurrency:
        options.runtimeConfig?.toolConcurrency?.maxConcurrency ??
        configResult.config.toolConcurrency.maxConcurrency,
    },
    modelAnomalyGuard: {
      ...configResult.config.modelAnomalyGuard,
      ...options.runtimeConfig?.modelAnomalyGuard,
    },
    mcp: {
      enabled: options.runtimeConfig?.mcp?.enabled ?? configResult.config.features.mcp,
      servers: autoConnectMcpServers,
      trustedOfficialCuaServerNames: [...trustedOfficialCuaServerNames],
    },
    hooks: mergeRuntimeHooks(
      options.runtimeConfig?.hooks
        ? withHookConfigSource(options.runtimeConfig.hooks, { kind: "internal" })
        : configResult.config.hooks,
      input.pluginHooks,
    ),
    subagents: {
      // Sando: ZCODE_SUBAGENT_MAX_PARALLEL / _RESULT_BYTES / _MAX_TURNS (SANDO-SUBAGENTS.md); explicit config wins.
      ...resolveSandoSubagentEnv(options.env ?? process.env),
      ...options.runtimeConfig?.subagents,
      enabled: options.runtimeConfig?.subagents?.enabled ?? configResult.config.features.subagent,
      outputRootDir: options.runtimeConfig?.subagents?.outputRootDir ?? subagentOutputRootDir,
      builtInModelSelectionOverrides: {
        ...(input.builtInSubagentModelSelectionOverrides ?? {}),
        ...runtimeBuiltInModelSelectionOverrides,
      },
      profiles: [...(options.runtimeConfig?.subagents?.profiles ?? []), ...subagentProfiles],
    },
    memory: {
      cliStorageRoot,
      enabled: options.runtimeConfig?.memory?.enabled ?? configResult.config.features.memory,
      ...(options.runtimeConfig?.memory?.extractionEnabled === undefined
        ? {}
        : { extractionEnabled: options.runtimeConfig.memory.extractionEnabled }),
      ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
      use: options.runtimeConfig?.memory?.use ?? configResult.config.memory.use,
      workspaceIdentity: workspaceIdentity?.trim() || undefined,
    },
  };
  return {
    configuredMcpServers,
    runtimeConfig,
    untrustedProjectMcpServers,
  };
}

function withHookConfigSource(
  config: HooksRuntimeConfig,
  source: HookConfigSource,
): HooksRuntimeConfig {
  return {
    ...config,
    events: Object.fromEntries(
      Object.entries(config.events).map(([eventName, matchers]) => [
        eventName,
        matchers?.map((matcher) => ({
          ...matcher,
          hooks: matcher.hooks.map((hook) => ({ ...hook, source: hook.source ?? source })),
        })),
      ]),
    ) as HooksRuntimeConfig["events"],
  };
}

function resolveInitialRegistrySelection(
  options: ZCodeAppOptions,
): ResolvedInitialRegistrySelection | undefined {
  const registry = options.providerRegistry;
  if (!registry) return undefined;

  if (options.runtimeConfig?.modelSelection) {
    const selection = options.runtimeConfig.modelSelection;
    if (options.resume && !registry.validateSelection(selection).ok) return undefined;
    const resolved = resolveRegistryOwnedModelSelection(registry, selection);
    return resolved
      ? {
          ...resolved,
          ...(selection.options ? { selectionOptions: selection.options } : {}),
        }
      : undefined;
  }

  if (options.resume) return undefined;
  // Sando: `--model <provider>/<model>` (ZCODE_MODEL) picks the model for this run only; nothing is persisted.
  // Unlike the configured default, a bad value is an error, not a silent fall back to the first registry model.
  const modelOverride = (options.env ?? process.env).ZCODE_MODEL?.trim();
  if (modelOverride) {
    const selection = resolveModelOverride(registry, modelOverride);
    const resolved = resolveRegistryOwnedModelSelection(registry, selection);
    if (!resolved) throw new Error(`--model: provider not found: ${selection.providerId}`);
    return { ...resolved, ...(selection.options ? { selectionOptions: selection.options } : {}) };
  }
  const initial = resolveInitialModelSelection({
    configuredDefault: options.configuredDefaultModelSelection,
    registry: registry.getView(),
  });
  if (initial.source === "none") return undefined;
  const resolved = resolveRegistryOwnedModelSelection(registry, initial.selection);
  return resolved
    ? {
        ...resolved,
        ...(initial.selection.options ? { selectionOptions: initial.selection.options } : {}),
      }
    : undefined;
}

function resolveMaxModelStepsPerTurn(
  options: ZCodeAppOptions,
): Pick<AgentRuntimeConfig, "maxModelStepsPerTurn"> {
  if (options.runtimeConfig?.maxModelStepsPerTurn !== undefined) {
    return { maxModelStepsPerTurn: options.runtimeConfig.maxModelStepsPerTurn };
  }
  const raw = (options.env ?? process.env).ZCODE_MAX_TURNS?.trim();
  if (!raw) return {};
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--max-turns expects a positive whole number, got "${raw}"`);
  }
  return { maxModelStepsPerTurn: value };
}

function resolveSandoSubagentEnv(
  env: Readonly<Record<string, string | undefined>>,
): Pick<
  NonNullable<AgentRuntimeConfig["subagents"]>,
  "maxParallel" | "resultMaxBytes" | "defaultTurnCap"
> {
  const read = (name: string, min: number): number | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`${name} expects a whole number >= ${min}, got "${raw}"`);
    }
    return value;
  };
  const maxParallel = read("ZCODE_SUBAGENT_MAX_PARALLEL", 1);
  const resultMaxBytes = read("ZCODE_SUBAGENT_RESULT_BYTES", 512);
  const defaultTurnCap = read("ZCODE_SUBAGENT_MAX_TURNS", 1);
  return {
    ...(maxParallel === undefined ? {} : { maxParallel }),
    ...(resultMaxBytes === undefined ? {} : { resultMaxBytes }),
    ...(defaultTurnCap === undefined ? {} : { defaultTurnCap }),
  };
}

/** Sando: "provider/model" → a validated selection; models with reasoning levels get the highest one. */
export function resolveModelOverride(
  registry: NonNullable<ZCodeAppOptions["providerRegistry"]>,
  value: string,
): ModelSelection {
  const parsed = parseProviderQualifiedModelSelection(value);
  if (!parsed) throw new Error(`--model expects <provider>/<model>, got "${value}"`);
  const validation = registry.validateSelection(parsed);
  if (validation.ok) return parsed;
  if (validation.code === "reasoning-level-missing") {
    const completed = completeNewModelSelection(registry.getView(), parsed);
    if (completed) return completed;
  }
  throw createRegistrySelectionProtocolError(validation);
}

function mergeRuntimeHooks(
  base: HooksRuntimeConfig | undefined,
  pluginHooks: Partial<Record<HookEventName, HookMatcherConfig[]>> | undefined,
): HooksRuntimeConfig | undefined {
  if (!pluginHooks || Object.values(pluginHooks).every((matchers) => !matchers?.length)) {
    return base;
  }

  const mergedEvents: HooksRuntimeConfig["events"] = {
    ...base?.events,
  };
  for (const [eventName, matchers] of Object.entries(pluginHooks) as Array<
    [HookEventName, HookMatcherConfig[]]
  >) {
    if (matchers.length === 0) continue;
    mergedEvents[eventName] = [...(mergedEvents[eventName] ?? []), ...matchers];
  }

  return {
    enabled: true,
    events: mergedEvents,
    maxOutputBytes: base?.maxOutputBytes ?? 32768,
    timeoutMs: base?.timeoutMs ?? 60000,
  };
}

export function runtimeConfigLogContext(
  runtimeConfig: AgentRuntimeConfig,
  workingDirectory: string,
) {
  const memoryRoot = runtimeConfig.memory?.cliStorageRoot
    ? getProjectMemoryRoot(
        runtimeConfig.memory.cliStorageRoot,
        workingDirectory,
        runtimeConfig.memory.workspaceIdentity,
      )
    : undefined;
  return {
    mcpEnabled: runtimeConfig.mcp?.enabled !== false,
    memoryEnabled: runtimeConfig.memory?.enabled !== false,
    memoryExtractionEnabled: runtimeConfig.memory?.extractionEnabled !== false,
    memoryRoot,
    memoryUse: runtimeConfig.memory?.use !== false,
    mcsMode: runtimeConfig.midConversationSystem?.mode,
    mode: runtimeConfig.mode,
    model: runtimeConfig.modelSelection
      ? `${runtimeConfig.modelSelection.providerId}/${runtimeConfig.modelSelection.modelId}`
      : undefined,
    runtimeFeatureBrowserUse: runtimeConfig.runtimeFeatures?.browserUse === true,
    runtimeFeatureNodeRepl: runtimeConfig.runtimeFeatures?.nodeRepl === true,
    workingDirectory,
  };
}
