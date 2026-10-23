// ---------------------------------------------------------------
// Invisible-character smuggling filter (Sando RD-2628, 2026-10-23)
// ---------------------------------------------------------------
//
// Two ways to hide a whole prompt inside text a person sees as one emoji or a plain sentence:
//   * Unicode TAG characters (U+E0000–E007F) spell ASCII invisibly.
//   * VARIATION SELECTORS (U+FE00–FE0F and U+E0100–E01EF): 256 of them, so one per byte. A run of
//     them after an emoji renders as just the emoji, while a model reading code points recovers the bytes.
//
// Kept: a single U+FE0E/U+FE0F directly after an emoji-capable character (❤️ U+2764 U+FE0F,
// ☺︎ U+263A U+FE0E, keycaps 1️⃣, ZWJ sequences 🏳️‍🌈), and the tag sequence of a subdivision flag
// (🏴 + 2–6 tag letters/digits + U+E007F).
// Removed: every U+E0100–E01EF, every other U+FE00–FE0F, every other tag character.
// Smuggling finding: any tag character outside a flag, any run of 3+ selectors, or 4+ stray selectors
// in one text (one hidden byte after each of many letters).
//
// Pure: no logging, no I/O. Callers log (counts only, never the hidden content) and flag the result.
// Ported from the Project Planner's server/src/services/invisibleChars.js so both scrub identically.

export const INVISIBLE_SELECTOR_RUN_LIMIT = 3;
export const INVISIBLE_STRAY_SELECTOR_LIMIT = 4;
export const INVISIBLE_TAG_LABEL = "Unicode tag characters";
export const INVISIBLE_SELECTOR_LABEL = "variation-selector smuggling";

export type InvisibleSmugglingLabel = typeof INVISIBLE_TAG_LABEL | typeof INVISIBLE_SELECTOR_LABEL;

export interface InvisibleScrubResult {
  /** The text with smuggling characters removed (the same string when nothing matched). */
  text: string;
  /** Smuggling labels found; empty when the text was clean or only had harmless stray selectors. */
  found: InvisibleSmugglingLabel[];
  removed: { tags: number; selectors: number };
  /** Number of selector runs of INVISIBLE_SELECTOR_RUN_LIMIT or more. */
  runs: number;
  smuggled: boolean;
}

const ANY_INVISIBLE = /[\uFE00-\uFE0F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
const SINGLE_EMOJI = /^\p{Emoji}$/u;
const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const FLAG_TAG_SPEC_MIN = 2;
const FLAG_TAG_SPEC_MAX = 6;

const isSelector = (cp: number): boolean =>
  (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
const isTag = (cp: number): boolean => cp >= 0xe0000 && cp <= 0xe007f;
const isFlagTagSpec = (cp: number): boolean =>
  (cp >= 0xe0030 && cp <= 0xe0039) || (cp >= 0xe0061 && cp <= 0xe007a);

/** Cheap pre-check: does the text contain any character this filter looks at? */
export function hasInvisibleCandidates(input: string): boolean {
  return ANY_INVISIBLE.test(input);
}

/**
 * Strip smuggling characters. Idempotent; text without any candidate character comes back
 * unchanged (the same string instance).
 */
export function scrubInvisible(input: string | null | undefined): InvisibleScrubResult {
  const s = String(input ?? "");
  if (!ANY_INVISIBLE.test(s)) {
    return { text: s, found: [], removed: { tags: 0, selectors: 0 }, runs: 0, smuggled: false };
  }
  const chars = Array.from(s);
  const cp = (i: number): number => chars[i]!.codePointAt(0)!;
  const out: string[] = [];
  let tags = 0;
  let selectors = 0;
  let stray = 0;
  let runs = 0;
  for (let i = 0; i < chars.length; ) {
    const c = cp(i);
    if (c === BLACK_FLAG) {
      // 🏴 + tag spec + cancel tag = a subdivision flag (England, Scotland, Wales …): keep verbatim.
      let j = i + 1;
      while (j < chars.length && j - i <= FLAG_TAG_SPEC_MAX && isFlagTagSpec(cp(j))) j++;
      if (j - i - 1 >= FLAG_TAG_SPEC_MIN && j < chars.length && cp(j) === CANCEL_TAG) {
        out.push(...chars.slice(i, j + 1));
        i = j + 1;
        continue;
      }
    }
    if (isTag(c)) {
      tags++;
      i++;
      continue;
    }
    if (isSelector(c)) {
      let j = i;
      while (j < chars.length && isSelector(cp(j))) j++;
      const len = j - i;
      if (len >= INVISIBLE_SELECTOR_RUN_LIMIT) {
        runs++;
        selectors += len;
      } else {
        const prev = i > 0 ? chars[i - 1]! : "";
        const keepFirst = (c === VS15 || c === VS16) && prev !== "" && SINGLE_EMOJI.test(prev);
        if (keepFirst) out.push(chars[i]!);
        const dropped = keepFirst ? len - 1 : len;
        selectors += dropped;
        stray += dropped;
      }
      i = j;
      continue;
    }
    out.push(chars[i]!);
    i++;
  }
  const found: InvisibleSmugglingLabel[] = [];
  if (tags > 0) found.push(INVISIBLE_TAG_LABEL);
  if (runs > 0 || stray >= INVISIBLE_STRAY_SELECTOR_LIMIT) found.push(INVISIBLE_SELECTOR_LABEL);
  return { text: out.join(""), found, removed: { tags, selectors }, runs, smuggled: found.length > 0 };
}

/** One visible line telling the model that hidden characters were taken out, or "" when not smuggled. */
export function scrubInvisibleNote(result: Pick<InvisibleScrubResult, "removed" | "found" | "smuggled">): string {
  if (!result.smuggled) return "";
  const n = result.removed.tags + result.removed.selectors;
  return `[${n} hidden character${n === 1 ? "" : "s"} removed: ${result.found.join(", ")}]`;
}
