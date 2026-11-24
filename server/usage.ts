import { z } from "zod";
import { moneySchema, type Metric, type MetricId } from "../shared/metrics.ts";

type Projection = Partial<Record<MetricId, Metric>>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const value = z.number().finite().nonnegative();
const tokenUsage = z.object({ input_tokens: count, output_tokens: count, cached_input_tokens: count });
const codexMetadata = z.object({
  threadId: z.string().min(1),
  complete: z.boolean(),
  usage: tokenUsage.optional(),
  compactionWindow: count.optional(),
});

/** Only the locator for a verified rollout may supply this metadata. */
export function projectCodex(raw: unknown, threadId: string, observedAt: number): Projection {
  const data = codexMetadata.parse(raw);
  if (data.threadId !== threadId) throw new Error("Codex thread mismatch");
  const common = { source: "codex", observedAt, state: data.complete ? "ready" : "partial" } as const;
  const absent = { source: common.source, observedAt, state: "no-records" } as const;
  const usage = data.usage;
  if (usage && usage.cached_input_tokens > usage.input_tokens) throw new Error("Invalid Codex cache counters");
  return {
    input: usage ? { ...common, value: usage.input_tokens } : absent,
    output: usage ? { ...common, value: usage.output_tokens } : absent,
    cache: usage?.input_tokens ? { ...common, value: usage.cached_input_tokens / usage.input_tokens * 100 } : absent,
    compactions: data.compactionWindow !== undefined ? { ...common, value: data.compactionWindow } : absent,
  };
}

const requestSchema = z.object({
  id: z.string().min(1).max(256),
  threadId: z.string().min(1),
  completedAt: z.number().int().nonnegative(),
  streaming: z.boolean(),
  ttftMs: value.optional(),
  tps: value.optional(),
  basis: z.enum(["output-tokens", "stream-output-tokens", "ttfb", "ttft"]).optional(),
});
const ledger = z.object({
  complete: z.boolean(),
  requests: z.array(requestSchema).max(1000),
  charges: z.array(z.object({
    id: z.string().min(1).max(256),
    threadId: z.string().min(1),
    settled: z.boolean(),
    money: moneySchema.optional(),
  })).max(1000),
});

function units(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole + fraction.padEnd(12, "0"));
}

export function projectGateway(raw: unknown, threadId: string, observedAt: number, source: "cchp" | "sub2api"): Projection {
  const data = ledger.parse(raw);
  if ([...data.requests, ...data.charges].some(row => row.threadId !== threadId)) throw new Error("Gateway thread mismatch");
  const latest = data.requests.filter(row => row.streaming).sort((a, b) =>
    b.completedAt - a.completedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  )[0];
  const requestInfo = { source, observedAt, sampleAt: latest?.completedAt, basis: latest?.basis };
  const perfState = data.complete ? "ready" : "partial";
  const totals = new Map<string, bigint>();
  const seen = new Map<string, string>();
  let pending = false;
  for (const charge of data.charges) {
    if (!charge.settled) { pending = true; continue; }
    if (!charge.money) throw new Error("Missing settlement amount");
    const { currency, amount } = charge.money;
    const minor = units(amount);
    const signature = `${currency}:${minor}`;
    if (seen.has(charge.id)) {
      if (seen.get(charge.id) !== signature) throw new Error("Conflicting settlement");
      continue;
    }
    seen.set(charge.id, signature);
    totals.set(currency, (totals.get(currency) ?? 0n) + minor);
  }
  const list = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, minor]) => {
    const digits = String(minor).padStart(13, "0");
    return { currency, amount: `${digits.slice(0, -12)}.${digits.slice(-12)}`.replace(/\.?0+$/, "") };
  });
  const common = { source, observedAt } as const;
  return {
    ttft: latest?.ttftMs === undefined ? { ...requestInfo, state: "no-records" } :
      { ...requestInfo, state: perfState, value: latest.ttftMs },
    tps: latest?.tps === undefined || !latest.basis ? { ...requestInfo, state: "no-records" } :
      { ...requestInfo, state: perfState, value: latest.tps },
    cost: list.length ? { ...common, state: data.complete && !pending ? "ready" : "partial", value: list } :
      { ...common, state: pending ? "waiting" : "no-records" },
  };
}
