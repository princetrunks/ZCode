// Spawns the gitignored venv's python3 + deepseek-recipe-bridge.py to run an OpenAI
// chat-completions-shaped body through DeepSeek's own deepseek-recipe conversion
// (ChatCompletionRequest(...).convert(ConversionOptions())) and returns the resulting
// Conversation.messages as plain JSON. See
// ~/apps/research/deepseek/deepseek-recipe/deepseek-recipe-python (MIT, PyPI
// `deepseek-recipe==0.2.0`). No network calls, no model inference -- pure protocol
// conversion, offline.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// support/ -> test/ -> adapters/ -> packages/ -> zcode-cli/ -> apps/ -> worktree root
const repoRoot = path.resolve(here, "../../../../../..");
const venvPython = path.join(repoRoot, ".venv-deepseek-recipe", "bin", "python3");
const bridgeScript = path.join(here, "deepseek-recipe-bridge.py");

/**
 * @param {Record<string, unknown>} wireBody OpenAI chat-completions-shaped request body
 *   (model, messages, optional tools/thinking), as produced by `toOpenAiWireMessages`.
 * @returns {{ messages: Array<{ role: string, content: string | null, reasoning_content: string | null,
 *   tool_calls: Array<{ id: string, name: string, arguments: string }> | null, tool_call_id: string | null }> }}
 */
export function convertViaDeepseekRecipe(wireBody) {
  const result = spawnSync(venvPython, [bridgeScript], {
    input: JSON.stringify(wireBody),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(
      `deepseek-recipe bridge failed to launch (${venvPython}): ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `deepseek-recipe bridge exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
}
