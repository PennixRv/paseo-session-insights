import { z } from "zod";
import { count, type AccountSnapshot } from "../shared/account.ts";
import { runLifecycle } from "./lifecycle-cchp.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const configSchema = z.strictObject({
  baseUrl: z.string().max(2048).refine(value => {
    try {
      const url = new URL(value);
      return !/[\s\\?#]/.test(value) && /^https:\/\//.test(value) && url.pathname === "/" &&
        !url.username && !url.password && url.port !== "0";
    } catch { return false; }
  }),
  accountId: count.positive(),
  token: z.string().regex(/^adm_sc_[A-Za-z0-9_-]{1,256}$/),
});
type Config = z.infer<typeof configSchema>;
type Lookup = Config | "disabled" | "missing-key" | "error";
const dateTime = z.iso.datetime({ offset: true });
const dateOnly = z.iso.date();
const shanghaiDate = (ms: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(ms);
const minute = 60_000;

export async function accountConfig(signal: AbortSignal): Promise<Lookup> {
  // Query the binding on each snapshot before reusing any protected reading.
  let settings;
  try {
    settings = JSON.parse(await runLifecycle(["config", "check", "--json"], signal, 64 * 1024));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "disabled" : "error";
  }
  if (settings?.values?.PENNIX_PASEO_SESSION_INSIGHTS_SUB2API !== "y") return "disabled";
  try {
    const raw = await runLifecycle(["secrets", "paseo-session-insights", "--source", "sub2api",
      "--paseo-home", resolve(process.env.PASEO_HOME || join(homedir(), ".paseo")), "--private-stdout"], signal, 8192);
    if (!raw) return "disabled";
    const value = JSON.parse(raw);
    if (value?.state === "missing-key") return "missing-key";
    const config = configSchema.safeParse(value);
    return config.success ? config.data : "error";
  } catch { return "error"; }
}

const windowSchema = z.object({
  limit_window_seconds: count, used_percent: z.number().finite().nonnegative(), reset_at: count,
});
const quotaSchema = z.object({
  rate_limit: z.object({ primary_window: windowSchema.nullish(), secondary_window: windowSchema.nullish() }).nullish(),
  rate_limit_reset_credits: z.object({
    available_count: count, credits: z.array(z.object({ expires_at: z.unknown().optional() })).optional(),
  }).nullish(),
});
const model = z.object({
  requests: count, total_tokens: count, input_tokens: count, output_tokens: count,
  cache_creation_tokens: count, cache_read_tokens: count,
});
const statsSchema = z.object({
  summary: z.object({ total_tokens: count, total_cost: z.number().finite().nonnegative(), total_requests: count, days: count }),
  history: z.array(z.object({ date: dateOnly })),
  models: z.unknown().optional(),
});
const identitySchema = z.object({
  id: count, platform: z.literal("openai"), type: z.literal("oauth"),
  credentials: z.object({ subscription_expires_at: z.unknown().optional() }).nullish(),
});
const success = z.object({ code: z.literal(0), data: z.unknown() });

function parseQuota(payload: unknown, now: number) {
  const data = quotaSchema.parse(payload);
  const windows = [data.rate_limit?.primary_window, data.rate_limit?.secondary_window].filter(
    item => item && item.limit_window_seconds === 604800,
  );
  const sevenDays = windows.length === 1 ? windows[0] : undefined;
  const window = sevenDays && sevenDays.reset_at > now / 1000 && sevenDays.reset_at < 253402300799
    ? { used: Math.min(100, sevenDays.used_percent), resetAt: sevenDays.reset_at } : null;
  const cards = data.rate_limit_reset_credits;
  if (!cards) return { window, cards: null };
  const dates = (cards.credits ?? []).flatMap(({ expires_at }) => {
    const checked = dateTime.safeParse(expires_at);
    return checked.success ? [checked.data] : [];
  });
  const incomplete = cards.available_count > 0 &&
    (dates.length !== cards.available_count || cards.credits?.length !== dates.length);
  dates.sort((a, b) => Date.parse(a) - Date.parse(b));
  return { window, cards: { count: cards.available_count, earliest: !incomplete && cards.available_count ? dates[0] : null, incomplete } };
}

function parseStats(payload: unknown, days: number, date: string) {
  const { summary, models, history } = statsSchema.parse(payload);
  const { total_tokens: tokens, total_cost: cost, total_requests: requests } = summary;
  const firstDay = new Date(Date.parse(`${date}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  // Sub2API 0.2.23 includes the exclusive end day in summary.days.
  if (![days, days + 1].includes(summary.days) || history.some(row => row.date < firstDay || row.date > date)) {
    throw new Error("Unexpected statistics window");
  }
  const rows = z.array(model).safeParse(models);
  let cache: number | null = null;
  if (rows.success) {
    const sums = rows.data.reduce((out, row) => {
      out.requests += row.requests;
      out.tokens += row.total_tokens;
      out.cached += row.cache_read_tokens;
      out.input += row.input_tokens + row.cache_creation_tokens + row.cache_read_tokens;
      out.complete &&= row.total_tokens === row.input_tokens + row.output_tokens + row.cache_creation_tokens + row.cache_read_tokens;
      return out;
    }, { requests: 0, tokens: 0, cached: 0, input: 0, complete: true });
    if (sums.complete && sums.requests === requests && sums.tokens === tokens && sums.input > 0) {
      cache = 100 * sums.cached / sums.input;
    }
  }
  return { tokens, cost, requests, cache };
}

class SourceError extends Error {
  readonly state: "forbidden" | "error" | "rate-limited";
  readonly wait: number;

  constructor(state: SourceError["state"], wait = 30_000) {
    super(state);
    this.state = state;
    this.wait = wait;
  }
}

async function fetchData(fetcher: typeof fetch, config: Config, path: string, signal: AbortSignal, now: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) throw new SourceError("error");
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 6000);
  try {
    return await readData(fetcher, config, path, controller.signal, now);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function readData(fetcher: typeof fetch, config: Config, path: string, signal: AbortSignal, now: number) {
  const response = await fetcher(new URL(path, config.baseUrl), {
    headers: { "x-api-key": config.token, accept: "application/json" },
    redirect: "error", signal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new SourceError("forbidden");
    if (response.status === 429) {
      const raw = response.headers.get("retry-after");
      const ms = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - now : NaN;
      throw new SourceError("rate-limited", Number.isFinite(ms) && ms >= 0 ? ms : minute);
    }
    throw new SourceError("error");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SourceError("error");
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 512 * 1024) throw new SourceError("error");
      text += decoder.decode(value, { stream: true });
    }
    return success.parse(JSON.parse(text + decoder.decode())).data;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

type Reading<T> = { state: "ready" | "stale" | "error" | "rate-limited"; data?: T };
type Cache<T> = { data?: T; checked: number; expires: number; retry: number; state: Reading<T>["state"] };
const blank = <T>() => ({ checked: 0, expires: 0, retry: 0, state: "error" } as Cache<T>);

export function createAccountReader(lookup = accountConfig, fetcher = globalThis.fetch, clock = Date.now) {
  let current: { config: Config; source: ReturnType<typeof bind> } | undefined;
  let pendingLookup: Promise<Lookup> | undefined;

  function bind(config: Config) {
    const root = `/api/v1/admin/accounts/${config.accountId}`;
    let today = blank<ReturnType<typeof parseStats>>();
    let week = blank<ReturnType<typeof parseStats>>();
    let date = "";
    const quota = blank<ReturnType<typeof parseQuota>>();
    const subscription = blank<string | null>();
    let deniedUntil = 0;
    let limitedUntil = 0;
    let pending: Promise<AccountSnapshot> | undefined;

    async function refresh(signal: AbortSignal): Promise<AccountSnapshot> {
      const now = clock();
      if (now < deniedUntil) return { state: "forbidden" };
      const day = shanghaiDate(now);
      if (day !== date) {
        date = day;
        today = blank();
        week = blank();
      }
      let forbidden = false;
      let retryAfter = 0;
      async function read<T>(cell: Cache<T>, path: string, ttl: number, parse: (data: unknown) => T,
        expiry?: (data: T) => number): Promise<Reading<T>> {
        if (now >= cell.expires && now >= cell.retry && now >= limitedUntil) {
          try {
            const data = parse(await fetchData(fetcher, config, path, signal, now));
            Object.assign(cell, { data, checked: clock(), retry: 0, state: "ready",
              expires: Math.min(now + ttl, expiry ? expiry(data) : Infinity) });
          } catch (error) {
            const fault = error instanceof SourceError ? error : new SourceError("error");
            if (fault.state === "forbidden") forbidden = true;
            if (fault.state === "rate-limited") retryAfter = Math.max(retryAfter, now + fault.wait);
            cell.retry = now + fault.wait;
            cell.state = fault.state === "rate-limited" ? "rate-limited" : "error";
          }
        }
        if (cell.state === "ready") return { state: "ready", data: cell.data };
        if (cell.data !== undefined && now < cell.checked + ttl + 5 * minute) {
          return { state: "stale", data: cell.data };
        }
        cell.data = undefined;
        return { state: now < limitedUntil ? "rate-limited" : cell.state };
      }
      const [quotaReading, subscriptionReading, todayReading, weekReading] = await Promise.all([
        read(quota, `/api/v1/admin/openai/accounts/${config.accountId}/quota`, 5 * minute,
          raw => parseQuota(raw, clock()), data => data.window ? data.window.resetAt * 1000 : Infinity),
        read(subscription, root, 30 * minute, raw => {
          const identity = identitySchema.safeParse(raw);
          if (!identity.success || identity.data.id !== config.accountId) throw new SourceError("forbidden");
          const expires = z.union([dateOnly, dateTime]).safeParse(identity.data.credentials?.subscription_expires_at);
          return expires.success ? expires.data : null;
        }),
        read(today, `${root}/stats?days=1`, minute, raw => parseStats(raw, 1, day)),
        read(week, `${root}/stats?days=7`, minute, raw => parseStats(raw, 7, day)),
      ]);
      const cells = [quota, subscription, today, week];
      if (forbidden) {
        deniedUntil = clock() + minute;
        for (const cell of cells) Object.assign(cell, blank(), { data: undefined });
        return { state: "forbidden" };
      }
      if (retryAfter) limitedUntil = retryAfter;
      if (quotaReading.data?.window && quotaReading.data.window.resetAt * 1000 <= clock()) {
        quotaReading.data = { ...quotaReading.data, window: null };
      }
      const rolled = shanghaiDate(clock()) !== day;
      return { state: "enabled", quota: quotaReading, subscription: subscriptionReading,
        today: rolled ? { state: "error" } : todayReading, week: rolled ? { state: "error" } : weekReading };
    }

    return (signal: AbortSignal) => pending ??= refresh(signal).finally(() => { pending = undefined; });
  }

  return async (signal: AbortSignal, statusOnly = false): Promise<AccountSnapshot> => {
    pendingLookup ??= lookup(signal).catch(() => "error" as const).finally(() => { pendingLookup = undefined; });
    const config = await pendingLookup;
    if (signal.aborted) return { state: "error" };
    if (typeof config === "string") {
      current = undefined;
      return { state: config };
    }
    if (!current || current.config.baseUrl !== config.baseUrl || current.config.accountId !== config.accountId ||
        current.config.token !== config.token) current = { config, source: bind(config) };
    if (statusOnly) return { state: "available" };
    const selected = current;
    const result = await selected.source(signal);
    return current === selected && !signal.aborted ? result : { state: "error" };
  };
}
