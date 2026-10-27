// Sando (ShrineTech): which fenced-code languages draw as rich blocks in assistant replies (2026-10-27).
// chartSpec.js is a verbatim Planner copy, so the Sando-only helpers live here.
const lang = (l: string | undefined | null): string => String(l || "").trim().toLowerCase();
export const isChartLanguage = (l: string | undefined | null): boolean => lang(l) === "chart";
export const isFlowLanguage = (l: string | undefined | null): boolean => lang(l) === "flow";
export { isAudioLanguage } from "./audioSpec.js";
