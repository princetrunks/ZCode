import { addMissingReasoningField, requiresReasoningField } from "./reasoning-profiles.js";

type ProviderFetch = typeof globalThis.fetch;

/**
 * Sando: OpenAI-compatible hosts whose reasoning profile wants `reasoning_content` on every assistant
 * message (DeepSeek's own API) get it filled in, empty when the turn had none. Any other host gets the
 * inner fetch back unchanged, so forge requests do not even pass through this wrapper.
 */
export function createReasoningFieldFetch(fetch: ProviderFetch, baseURL: string | undefined): ProviderFetch {
  if (!baseURL || !/deepseek/i.test(baseURL)) return fetch;
  return async (request, init) => {
    if (typeof init?.body !== "string") return fetch(request, init);
    let body: { model?: unknown; messages?: unknown };
    try {
      body = JSON.parse(init.body) as typeof body;
    } catch {
      return fetch(request, init);
    }
    if (typeof body.model !== "string" || !requiresReasoningField(body.model, baseURL)) {
      return fetch(request, init);
    }
    const patched = addMissingReasoningField(body);
    return patched === body ? fetch(request, init) : fetch(request, { ...init, body: JSON.stringify(patched) });
  };
}
