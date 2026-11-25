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
type StreamSample = { id: string; threadId: string; streaming: boolean; completedAt: number;
  ttftMs?: number; tps?: number; basis?: "ttfb" | "ttft" };
type Scan = ReturnType<typeof newScan>;

function newScan(end?: string) {
  return { end, cursor: null as string | null, finished: false, complete: false,
    cursors: new Set<string>(), charges: new Map<string, Charge>() };
}

class GatewayError extends Error {
  readonly state: Unavailable;
  constructor(state: Unavailable) {
    super(state);
    this.state = state;
  }
}

class GatewayUnavailable extends Error {}

function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof TypeError) || !(error.cause instanceof Error)) return false;
  const cause = error.cause as Error & { code?: string };
  return /^(?:EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|ECONNREFUSED|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT))$/
    .test(cause.code ?? "");
}

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

function unavailable(state: Unavailable, costInfo?: Pick<Metric, "hasMoreBilling" | "retryAt">) {
  const metric: Metric = { source: "cchp", state };
  return { ttft: metric, tps: metric, cost: costInfo ? { ...metric, ...costInfo } : metric };
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
  const costByThread = new Map<string, { touchedAt: number; expires: number; metric?: Metric; scan?: Scan }>();
  const active = new Map<string, ReturnType<typeof read>>();
  async function read(threadId: string, lifetime: AbortSignal) {
    if (lifetime.aborted) return unavailable("error");
    const now = clock();
    for (const [id, cost] of costByThread) {
      if (!cost.scan && cost.touchedAt + 300_000 <= now) costByThread.delete(id);
    }
    const cached = costByThread.get(threadId);
    if (now < retryAt) {
      return unavailable("rate-limited", {
        retryAt,
        hasMoreBilling: cached?.scan ? true : undefined,
      });
    }
    const scan = cached?.metric && cached.expires > now ? undefined :
      cached?.scan ?? newScan(new Date(now).toISOString());
    const previousCursor = scan?.cursor;
    function saveCost(value: NonNullable<typeof cached>) {
      costByThread.delete(threadId);
      if (costByThread.size >= 16) {
        const oldest = costByThread.keys().next();
        if (!oldest.done) costByThread.delete(oldest.value);
      }
      costByThread.set(threadId, value);
    }
    try {
      const endpoint = new URL(options.baseUrl);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
        endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(options.apiKeyId)) return unavailable("unsupported");
      endpoint.pathname = "/api/account/usage/logs";
      endpoint.searchParams.set("sessionId", threadId);
      endpoint.searchParams.set("apiKeyIds", options.apiKeyId);
      endpoint.searchParams.set("sort", "startedAtDesc");
      const requests = new Map<string, StreamSample>();
      async function collect(scan: Scan, maxPages: number, signal: AbortSignal, sample: boolean) {
        const url = new URL(endpoint);
        url.searchParams.set("limit", scan.end ? "200" : "100");
        if (scan.end) url.searchParams.set("end", scan.end);
        for (let i = 0; i < maxPages && !scan.finished && !signal.aborted; i++) {
          if (scan.cursor) url.searchParams.set("cursor", scan.cursor);
          let page: z.infer<typeof pageSchema>["page"];
          try {
            const response = await fetchImpl(url.href, {
              method: "GET",
              headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json" },
              redirect: "error", signal,
            });
            if (!response.ok) {
              await response.body?.cancel().catch(() => {});
              if (response.status === 403 || response.status === 401) throw new GatewayError("forbidden");
              if (response.status === 429) {
                const retryAfter = response.headers.get("retry-after");
                const millis = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 :
                  retryAfter && Number.isFinite(Date.parse(retryAfter)) ? Date.parse(retryAfter) - clock() : 30_000;
                retryAt = Math.min(8_640_000_000_000_000, clock() + Math.max(1000, millis));
                throw new GatewayError("rate-limited");
              }
              if (response.status >= 500) throw new GatewayUnavailable();
              throw new GatewayError("error");
            }
            page = pageSchema.parse(await boundedJson(response)).page;
          } catch (error) {
            if (!(error instanceof GatewayError) && signal.aborted && !lifetime.aborted) break;
            if (isNetworkFailure(error)) throw new GatewayUnavailable();
            throw error;
          }
          for (const row of page.items) {
            if (row.apiKeyId !== options.apiKeyId || row.sessionId !== threadId ||
              (row.clientSessionId != null && row.clientSessionId !== threadId)) throw new GatewayError("unlinked");
            const completedAt = row.completedAt == null ? null : Date.parse(row.completedAt);
            if (completedAt !== null && !Number.isFinite(completedAt)) throw new GatewayError("error");
            const charge = readCharge(row, threadId);
            const previousCharge = scan.charges.get(charge.id);
            if (charge.settled && previousCharge?.settled && charge.money?.amount !== previousCharge.money?.amount) {
              throw new GatewayError("error");
            }
            if (!previousCharge?.settled) scan.charges.set(charge.id, charge);
            if (!sample || !row.streaming || completedAt === null) continue;
            const reading = {
              id: row.requestId, threadId, completedAt, streaming: true,
              ttftMs: row.ttftMs ?? undefined,
              tps: row.tpsMilli == null ? undefined : row.tpsMilli / 1000,
              basis: row.tpsBasis ?? undefined,
            };
            const previous = requests.get(reading.id);
            if (previous && JSON.stringify(previous) !== JSON.stringify(reading)) throw new GatewayError("error");
            requests.set(reading.id, reading);
          }
          scan.cursor = page.nextCursor;
          if (scan.cursor === null) {
            scan.finished = true;
            scan.complete = !page.totalIsLowerBound;
          } else {
            if (scan.cursors.has(scan.cursor)) throw new GatewayError("error");
            scan.cursors.add(scan.cursor);
          }
        }
      }
      async function withinBudget(timeout: number, read: (signal: AbortSignal) => Promise<void>) {
        if (lifetime.aborted) throw new GatewayError("error");
        const controller = new AbortController();
        const cancel = () => controller.abort();
        lifetime.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(cancel, timeout);
        try { await read(controller.signal); }
        finally {
          clearTimeout(timer);
          lifetime.removeEventListener("abort", cancel);
        }
      }
      const resume = Boolean(cached?.scan);
      const recent = !scan || resume ? newScan() : scan;
      await withinBudget(scan && resume ? 1500 : scan ? 4500 : 3000,
        signal => collect(recent, recent === scan ? 10 : 3, signal, true));
      if (scan && resume) await withinBudget(3000, signal => collect(scan, 7, signal, false));
      if (lifetime.aborted) throw new GatewayError("error");

      const observedAt = clock();
      const readings = recent.finished || recent.cursor
        ? projectGateway({ complete: recent.complete, requests: [...requests.values()],
          charges: [...recent.charges.values()] }, threadId, observedAt, "cchp")
        : unavailable("error");
      if (!scan) {
        if (cached) saveCost({ ...cached, touchedAt: observedAt });
        return { ...readings, cost: cached?.metric };
      }
      const charges = [...scan.charges.values()];
      const projected = scan === recent ? readings : projectGateway({ complete: scan.complete, requests: [], charges },
        threadId, observedAt, "cchp");
      const cost = projected.cost && !scan.finished
        ? { ...projected.cost, hasMoreBilling: true as const } : projected.cost;
      saveCost({
        touchedAt: observedAt, expires: scan.finished ? observedAt + 60_000 : 0,
        metric: scan.finished ? cost : cached?.metric, scan: scan.finished ? undefined : scan,
      });
      if (!scan.finished && scan.cursor === previousCursor) {
        return { ...readings, cost: { source: "cchp", state: "error", hasMoreBilling: true } satisfies Metric };
      }
      const last = cached?.metric;
      return { ...readings, cost: !scan.finished && last && "value" in last && cost
        ? { ...last, state: "stale" as const, hasMoreBilling: true as const, basis: "显示上次核对的金额" }
        : cost };
    } catch (error) {
      if (error instanceof GatewayUnavailable && !lifetime.aborted) {
        const observedAt = clock();
        const last = cached?.metric;
        const recentCost = last && "value" in last && last.observedAt !== undefined &&
          observedAt - last.observedAt < 300_000 ? last : undefined;
        const canResume = Boolean(scan?.cursor && !scan.finished);
        if (canResume) saveCost({ touchedAt: observedAt, expires: 0, metric: recentCost, scan });
        const failed = unavailable("error");
        if (recentCost) return { ...failed, cost: {
          ...recentCost, state: "stale" as const, basis: "显示上次核对的金额",
          hasMoreBilling: canResume ? true as const : undefined,
        } };
        if (canResume && scan) {
          const { cost } = projectGateway({ complete: false, requests: [], charges: [...scan.charges.values()] },
            threadId, observedAt, "cchp");
          return { ...failed, cost: { ...(cost ?? failed.cost), hasMoreBilling: true as const } };
        }
        return failed;
      }
      const state = error instanceof GatewayError ? error.state : "error";
      if (state === "rate-limited") {
        if (scan) saveCost({ touchedAt: clock(), expires: 0, metric: cached?.metric, scan });
        return unavailable(state, { retryAt, hasMoreBilling: scan ? true : undefined });
      }
      costByThread.delete(threadId);
      return unavailable(state);
    }
  }
  return async (threadId: string | null, lifetime: AbortSignal) => {
    if (!threadId) return unavailable("waiting");
    if (lifetime.aborted) return unavailable("error");
    let pending = active.get(threadId);
    if (!pending) {
      pending = read(threadId, lifetime).finally(() => active.delete(threadId));
      active.set(threadId, pending);
    }
    return await pending;
  };
}
