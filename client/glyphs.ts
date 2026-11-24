import type { MetricId } from "../shared/metrics.ts";

export const fieldGlyphs = {
  input: "\u{F021A}",
  output: "\u{F021A}",
  cachedInput: "\u{F0CFF}",
  cache: "\u{F0CFF}",
  compactions: "\u{F1B8}",
  cost: "\u{F0584}",
  ttft: "\u{EF0C}",
  tps: "\u{F04C5}",
  planning: "\u{F0EA6}",
  inProgress: "\u{F0EA6}",
  completed: "\u{F0EA6}",
  working: "\u{F01D}",
  idle: "\u{F192}",
  error: "\u{F29C}",
  ended: "\u{F05D}",
} satisfies Record<MetricId, string>;
