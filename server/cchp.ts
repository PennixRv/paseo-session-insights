import { z } from "zod";
import type { Metric, Unavailable } from "../shared/metrics.ts";
import { projectGateway } from "./usage.ts";

const integer = z.number().nonnegative().int().max(Number.MAX_SAFE_INTEGER);
const rowSchema = z.object({
  requestId: z.string().min(1).max(256),
  sessionId: z.string().nullable(),
  clientSessionId: z.string().nullish(),
  apiKeyId: z.string().nullable(),
  completedAt: z.string().nullable(),
  streaming: z.boolean(),
  ttftMs: integer.nullish(),
  tpsMilli: integer.nullish(),
  tpsBasis: z.enum(["ttfb", "ttft"]).nullish(),
  costUnits: z.unknown().optional(),
  adjustedCostUnits: z.unknown().optional(),
});
const pageSchema = z.object({ page: z.object({
  items: z.array(rowSchema).max(200),
  nextCursor: z.string().max(2048).min(1).nullable(),
  totalIsLowerBound: z.boolean().optional(),
}) });

type Options = { baseUrl: string; token: string; apiKeyId: string };
type Charge = { id: string; threadId: string; settled: boolean; money?: { currency: "CRED"; amount: string } };

function readCharge(row: z.infer<typeof rowSchema>, threadId: string): Charge {
  const id = row.requestId;
  const units = integer.safeParse(row.adjustedCostUnits ?? row.costUnits);
  if (row.completedAt == null || row.adjustedCostUnits === undefined || !units.success) {
    return { id, threadId, settled: false };
  }
  // CCHP's billing ledger uses 10^10 units per credit.
  const digits = String(units.data).padStart(11, "0");
  return { id, threadId, settled: true, money: {
    currency: "CRED", amount: `${digits.slice(0, -10)}.${digits.slice(-10)}`,
  } };
}

function unavailable(state: Unavailable) {
  const metric = { source: "cchp", state } satisfies Metric;
  return { ttft: metric, tps: metric, cost: metric };
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing gateway response body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 768 * 1024) throw new Error("Gateway response exceeds limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createCchpReader(options: Options, fetchImpl = globalThis.fetch, clock = Date.now) {
  let retryAt = 0;
  const costByThread = new Map<string, { expires: number; metric: Metric }>();
  return async function read(threadId: string | null, lifetime: AbortSignal) {
    if (!threadId) return unavailable("waiting");
    if (clock() < retryAt) return unavailable("rate-limited");
    if (lifetime.aborted) return unavailable("error");
    const now = clock();
    for (const [id, cost] of costByThread) if (cost.expires <= now) costByThread.delete(id);
    const cachedCost = costByThread.get(threadId);
    const request = new AbortController();
    const abort = () => request.abort();
    lifetime.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, cachedCost ? 3000 : 4500);
    try {
      const endpoint = new URL(options.baseUrl);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
        endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(options.apiKeyId)) return unavailable("unsupported");
      endpoint.pathname = "/api/account/usage/logs";
      endpoint.searchParams.set("sessionId", threadId);
      endpoint.searchParams.set("apiKeyIds", options.apiKeyId);
      endpoint.searchParams.set("limit", cachedCost ? "100" : "200");
      endpoint.searchParams.set("sort", "startedAtDesc");

      const cursorHistory = new Set<string>();
      const requests = new Map<string, { id: string; threadId: string; streaming: boolean; completedAt: number;
        ttftMs?: number; tps?: number; basis?: "ttfb" | "ttft" }>();
      const charges: Charge[] = [];
      let complete = false;
      // shortcut: bound a cost scan to 2,000 rows; use a scoped aggregate if CCHP exposes one.
      const maxPages = cachedCost ? 3 : 10;
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
        const response = await fetchImpl(endpoint.href, {
          method: "GET",
          headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json" },
          redirect: "error",
          signal: request.signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 403 || response.status === 401) return unavailable("forbidden");
          if (response.status === 429) {
            const retryAfter = response.headers.get("retry-after");
            const millis = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 :
              retryAfter && Number.isFinite(Date.parse(retryAfter)) ? Date.parse(retryAfter) - clock() : 30_000;
            retryAt = clock() + Math.max(1000, Math.min(300_000, millis));
            return unavailable("rate-limited");
          }
          return unavailable("error");
        }
        const { page } = pageSchema.parse(await boundedJson(response));
        for (const row of page.items) {
          if (row.apiKeyId !== options.apiKeyId || row.sessionId !== threadId ||
            (row.clientSessionId != null && row.clientSessionId !== threadId)) return unavailable("unlinked");
          const completedAt = row.completedAt == null ? null : Date.parse(row.completedAt);
          if (completedAt !== null && !Number.isFinite(completedAt)) return unavailable("error");
          charges.push(readCharge(row, threadId));
          if (!row.streaming || completedAt === null) continue;
          const reading = {
            id: row.requestId, threadId, completedAt, streaming: true,
            ttftMs: row.ttftMs ?? undefined,
            tps: row.tpsMilli == null ? undefined : row.tpsMilli / 1000,
            basis: row.tpsBasis ?? undefined,
          };
          const previous = requests.get(reading.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(reading)) return unavailable("error");
          requests.set(reading.id, reading);
        }
        if (page.nextCursor == null) {
          complete = !page.totalIsLowerBound;
          break;
        }
        if (cursorHistory.has(page.nextCursor)) return unavailable("error");
        cursorHistory.add(page.nextCursor);
        endpoint.searchParams.set("cursor", page.nextCursor);
      }
      const observedAt = clock();
      const readings = projectGateway({ complete, requests: [...requests.values()], charges }, threadId, observedAt, "cchp");
      if (cachedCost && !complete) return { ...readings, cost: cachedCost.metric };
      const count = new Set(charges.map(charge => charge.id)).size;
      const cost = readings.cost && {
        ...readings.cost,
        basis: !complete ? `仅查询最近 ${count} 条请求` : readings.cost.state === "partial" ?
          `已查询 ${count} 条请求，部分未结算` : `已查询 ${count} 条请求`,
      };
      if (cost) {
        if (!costByThread.has(threadId) && costByThread.size >= 16) {
          const oldest = costByThread.keys().next();
          if (!oldest.done) costByThread.delete(oldest.value);
        }
        costByThread.set(threadId, { expires: observedAt + 60_000, metric: cost });
      }
      return { ...readings, cost };
    } catch {
      return unavailable("error");
    } finally {
      clearTimeout(timer);
      lifetime.removeEventListener("abort", abort);
    }
  };
}
