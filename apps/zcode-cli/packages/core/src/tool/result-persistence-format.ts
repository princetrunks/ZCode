const PERSISTED_OUTPUT_OPEN_TAG = "<persisted-output>";
const PERSISTED_OUTPUT_CLOSE_TAG = "</persisted-output>";
// Artifact strategy uses resultBudget as the persistence trigger; once persisted, this independent
// preview budget controls the provider-visible <persisted-output> snippet.
const PERSISTED_OUTPUT_PREVIEW_CHARS = 2_000;
// Sando: the preview also shows the last chars of the output, because build/test logs put the
// error and the summary at the end (idea from DeepSeek Harness spill-policy, MIT; no code copied).
export const PERSISTED_OUTPUT_PREVIEW_TAIL_CHARS = 1_000;

interface PersistedOutputEnvelopeInput {
  content: string;
  formatBytes: (bytes: number) => string;
  originalBytes: number;
  persistedPath: string;
  previewChars: number;
  /** Chars kept from the end of the output; defaults to PERSISTED_OUTPUT_PREVIEW_TAIL_CHARS. */
  tailChars?: number;
}

export function formatGenericPersistedOutputContent(input: {
  content: string;
  originalBytes: number;
  persistedPath: string;
}): string {
  return formatPersistedOutputEnvelope({
    content: input.content,
    formatBytes: formatDecimalBytes,
    originalBytes: input.originalBytes,
    persistedPath: input.persistedPath,
    previewChars: PERSISTED_OUTPUT_PREVIEW_CHARS,
  });
}

export function formatPersistedOutputEnvelope(input: PersistedOutputEnvelopeInput): string {
  const tailChars = input.tailChars ?? PERSISTED_OUTPUT_PREVIEW_TAIL_CHARS;
  const preview = previewHeadAndTail(input.content, input.previewChars, tailChars);
  const header = preview.tail
    ? `Preview (first ${input.formatBytes(input.previewChars)} and last ${input.formatBytes(tailChars)}):`
    : `Preview (first ${input.formatBytes(input.previewChars)}):`;
  return [
    PERSISTED_OUTPUT_OPEN_TAG,
    `Output too large (${input.formatBytes(input.originalBytes)}). Full output saved to: ${input.persistedPath}`,
    "",
    header,
    preview.head,
    preview.omittedChars > 0 ? formatOmittedMarker(preview.omittedChars) : undefined,
    preview.tail,
    PERSISTED_OUTPUT_CLOSE_TAG,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function formatOmittedMarker(omittedChars: number): string {
  return `… ${omittedChars} chars omitted …`;
}

export function isPersistedOutputContent(content: string): boolean {
  return (
    content.startsWith(PERSISTED_OUTPUT_OPEN_TAG) && content.includes(PERSISTED_OUTPUT_CLOSE_TAG)
  );
}

interface HeadTailPreview {
  head: string;
  omittedChars: number;
  tail?: string;
}

function previewHeadAndTail(
  content: string,
  headChars: number,
  tailChars: number,
): HeadTailPreview {
  if (content.length <= headChars) return { head: content, omittedChars: 0 };

  const head = content.slice(0, cutHeadAtLine(content, headChars));
  const rest = content.length - head.length;
  const tailBudget = Math.max(0, Math.floor(tailChars));
  if (tailBudget === 0) return { head, omittedChars: rest };
  // 剩余部分装得进 tail 预算时没有可省略的中段，直接给全文。
  if (rest <= tailBudget) return { head: content, omittedChars: 0 };
  const tail = content.slice(content.length - cutTailAtLine(content, tailBudget));
  return { head, omittedChars: content.length - head.length - tail.length, tail };
}

/** Length of the head: end at the last newline when it is in the second half of the budget. */
function cutHeadAtLine(content: string, maxChars: number): number {
  const newlineIndex = content.slice(0, maxChars).lastIndexOf("\n");
  return newlineIndex > maxChars * 0.5 ? newlineIndex : maxChars;
}

/** Length of the tail: start after the first newline when it is in the first half of the budget. */
function cutTailAtLine(content: string, maxChars: number): number {
  const window = content.slice(content.length - maxChars);
  const newlineIndex = window.indexOf("\n");
  return newlineIndex >= 0 && newlineIndex < maxChars * 0.5
    ? maxChars - newlineIndex - 1
    : maxChars;
}

function formatDecimalBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1_000_000_000)} GB`;
}
