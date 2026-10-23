import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { Logger, Model } from "../deps.js";
import type { AgentRuntimeConfig } from "../types.js";
import {
  buildProviderRequestMessages,
  type ProviderRequestMessageProjectionResult,
} from "./provider-request-messages.js";
import { logInvisibleScrubFindings } from "./provider-invisible-scrub.js";

export function buildRuntimeProviderRequestMessages(
  runtime: {
    readonly config: Pick<AgentRuntimeConfig, "midConversationSystem">;
    readonly logger?: Logger;
  },
  input: {
    entries: readonly RuntimeMessageEntry[];
    applyCacheControl?: boolean;
    model: Model;
  },
): ProviderRequestMessageProjectionResult {
  const useMidConversationSystem =
    runtime.config.midConversationSystem?.mode === "force" ||
    input.model.properties.supportsMidConversationSystem;
  const projection = buildProviderRequestMessages({
    ...input,
    useMidConversationSystem,
  });
  logInvisibleScrubFindings(runtime.logger, projection.diagnostics.invisibleScrubFindings);
  return projection;
}
