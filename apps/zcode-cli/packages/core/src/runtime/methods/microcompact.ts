import {
  CompactPhase,
  SessionEventType,
  buildDefaultMicrocompactThreshold,
  getAutoCompactThreshold,
  toolResultPrunerEnabledFromEnv,
  traceContextToLogContext,
} from "../deps.js";
import type {
  AutoCompactPolicyConfig,
  LocalMicrocompactPolicyConfig,
  Model,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import { maybeLocalMicrocompactRuntimeEntries, throwIfTurnAborted } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildAutoCompactPolicyConfig } from "./auto-compact-config.js";
import type { TurnRequestState } from "./turn-loop-state.js";
import {
  filterOutputTokenContinuationEntries,
  preserveCanonicalContextPrefix,
} from "./turn-output-token-continuation.js";

export async function microcompactIfNeeded(
  this: AgentRuntimeInternal,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  abortSignal: AbortSignal | undefined,
  context: {
    model: Model;
    modelStepIndex: number;
    phase: CompactPhase;
    turnRequestState: TurnRequestState;
  },
): Promise<void> {
  if (this.config.compact?.enabled === false) return;
  throwIfTurnAborted(abortSignal);

  const autoConfig = buildAutoCompactPolicyConfig(this, context.model);
  const microcompactConfig = resolveLocalMicrocompactConfig(autoConfig);
  const useMidConversationSystem =
    this.config.midConversationSystem?.mode === "force" ||
    context.model.properties.supportsMidConversationSystem;
  const result = maybeLocalMicrocompactRuntimeEntries({
    config: microcompactConfig,
    entries: context.turnRequestState.entries,
    lastAssistantCompletedAtMs: this.lastAssistantCompletedAtMs,
    useMidConversationSystem,
  });

  if (!result.payload) {
    this.logger?.debug("Microcompact skipped", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.micro.skipped",
      estimatedTokenCount: result.decision.estimatedTokenCount,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      reason: result.decision.reason,
      thresholdTokens: result.decision.thresholdTokens,
      trigger: result.decision.trigger,
    });
    return;
  }

  const recordableEntries = filterOutputTokenContinuationEntries(result.entries);
  this.messageHistory.replaceMessages(
    preserveCanonicalContextPrefix(
      this.messageHistory.borrowReadOnlyRuntimeEntries(),
      recordableEntries,
    ),
  );
  context.turnRequestState.entries = result.entries;

  const payload = {
    ...result.payload,
    traceId: turnTraceContext.traceId,
    turnId: turnTraceContext.turnId,
  };
  const event = this.createEvent(SessionEventType.MicrocompactBoundary, payload, turnTraceContext);
  await this.appendEvent(event, turnTraceContext);
  events.push(event);

  this.logger?.info("Microcompact applied", {
    ...traceContextToLogContext(turnTraceContext),
    clearedMessageCount: payload.clearedMessageCount,
    event: "compact.micro.applied",
    prunedMessageCount: payload.prunedToolCallIds?.length ?? 0,
    strategy: payload.strategy,
    modelStepIndex: context.modelStepIndex,
    module: "core.runtime",
    phase: context.phase,
    postMicrocompactTokenCount: payload.postMicrocompactTokenCount,
    preMicrocompactTokenCount: payload.preMicrocompactTokenCount,
    tokensSaved: payload.tokensSaved,
    trigger: payload.trigger,
  });
}

function resolveLocalMicrocompactConfig(
  config: AutoCompactPolicyConfig,
): LocalMicrocompactPolicyConfig {
  const fullCompactThreshold = getAutoCompactThreshold(config);
  return {
    ...config.microcompact,
    enabled: config.microcompact?.enabled === true,
    // Sando: head + tail pruning of old tool results is on unless SANDO_TOOL_RESULT_PRUNER=off.
    pruner: {
      ...config.microcompact?.pruner,
      enabled: config.microcompact?.pruner?.enabled ?? toolResultPrunerEnabledFromEnv(),
    },
    thresholdTokens:
      config.microcompact?.thresholdTokens ??
      buildDefaultMicrocompactThreshold(fullCompactThreshold),
  };
}
