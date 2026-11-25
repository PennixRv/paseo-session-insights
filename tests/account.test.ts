import assert from "node:assert/strict";
import { test } from "node:test";
import { accountRpc, accountTitle } from "../shared/account.ts";
import { createAccountReader } from "../server/sub2api.ts";

const settings = { baseUrl: "https://sub2api.invalid", accountId: 17, token: "adm_sc_synthetic" };
const signal = new AbortController().signal;
const start = Date.parse("2026-11-25T23:58:00+08:00");
const json = (data: unknown) => Response.json({ code: 0, data });

function stats(days: number, complete = true) {
  return {
    summary: { days: days + 1, total_requests: 2, total_tokens: 150, total_cost: 0.001 },
    history: [],
    models: complete ? [{ requests: 2, total_tokens: 150, input_tokens: 40, output_tokens: 50,
      cache_creation_tokens: 10, cache_read_tokens: 50 }] : null,
  };
}

test("projects only display fields and deduplicates queries across clients", async () => {
  const paths: string[] = [];
  const reader = createAccountReader(async () => settings, async (request, init) => {
    const url = new URL(String(request));
    assert.equal(url.origin, settings.baseUrl);
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("x-api-key"), settings.token);
    paths.push(url.pathname + url.search);
    if (url.pathname.endsWith("/quota")) return json({
      email: "fixture-private", plan_type: "prolite",
      rate_limit: {
        primary_window: { limit_window_seconds: 18_000, used_percent: 0, reset_at: Math.floor(start / 1000) + 180 },
        secondary_window: { limit_window_seconds: 604_800, used_percent: 42.37, reset_at: Math.floor(start / 1000) + 3600 },
      },
      rate_limit_reset_credits: { available_count: 2, credits: [{ expires_at: "2026-11-30T10:00:00Z" }, {}] },
    });
    if (!url.search) return json({ id: 17, platform: "openai", type: "oauth",
      credentials: { subscription_expires_at: "2026-12-18", email: "fixture-private", plan_type: "pro" } });
    return json(stats(Number(url.searchParams.get("days")), url.searchParams.get("days") === "1"));
  }, () => start);
  const status = await reader(signal, true);
  assert(status.state === "available" && status.binding?.length === 64);
  assert.equal(paths.length, 0);
  const [a, b] = await Promise.all([reader(signal), reader(signal)]);
  assert.deepEqual(a, b);
  assert.equal(paths.length, 4);
  const result = accountRpc.output.parse(a);
  assert.equal(result.state, "enabled");
  if (result.state !== "enabled") throw Error("expected enabled");
  assert.equal(result.binding, status.binding);
  assert.equal(accountTitle(result), "ChatGPT Pro 100");
  assert.equal("plan" in (result.quota.data ?? {}), false);
  assert.equal(result.quota.data?.window?.used, 42.37);
  assert.deepEqual(result.quota.data?.cards, { count: 2, earliest: null, incomplete: true });
  assert.equal(result.subscription.data, "2026-12-18");
  assert.equal(result.today.data?.cache, 50);
  assert.equal(result.today.data?.cost, 0.001);
  assert.equal(result.week.data?.cache, null);
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|adm_sc/);
  await reader(signal);
  assert.equal(paths.length, 4);
});

test("only known account plans are displayed, with identity as a fallback", async () => {
  for (const [quotaPlan, identityPlan, title] of [
    [null, "  Plus ", "ChatGPT Plus"],
    ["unknown", "chatgpt_pro", "ChatGPT Pro 200"],
    ["future-private-text", 100, "ChatGPT Status"],
  ] as const) {
    const reader = createAccountReader(async () => settings, async request => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/quota")) return json({ plan_type: quotaPlan });
      if (!url.search) return json({ id: 17, platform: "openai", type: "oauth", credentials: { plan_type: identityPlan } });
      return json(stats(Number(url.searchParams.get("days"))));
    }, () => start);
    const result = await reader(signal);
    assert.equal(accountTitle(result), title);
    assert.doesNotMatch(JSON.stringify(result), /future-private-text/);
  }
});

test("drops previous statistics after Shanghai midnight, and all readings on denial or rebinding", async () => {
  let now = start;
  let selected = settings;
  let failure = 0;
  const reader = createAccountReader(async () => selected, async request => {
    const url = new URL(String(request));
    if (url.pathname.endsWith("/quota")) return json({});
    if (!url.search) return json({ id: 17, platform: "openai", type: "oauth" });
    return failure ? new Response(null, { status: failure }) : json(stats(Number(url.searchParams.get("days"))));
  }, () => now);
  assert.equal((await reader(signal)).state, "enabled");
  failure = 502;
  now += 61_000;
  const stale = await reader(signal);
  assert(stale.state === "enabled" && stale.today.state === "stale" && stale.today.data);
  now += 60_000;
  const midnight = await reader(signal);
  assert(midnight.state === "enabled" && midnight.today.state === "error" && !midnight.today.data && !midnight.week.data);
  failure = 403;
  now += 61_000;
  const denied = await reader(signal);
  assert.equal(denied.state, "forbidden");
  selected = { ...settings, accountId: 18, token: "adm_sc_new_synthetic" };
  failure = 0;
  const rebound = await reader(signal);
  assert(rebound.state === "forbidden" && denied.state === "forbidden");
  assert.notEqual(rebound.binding, denied.binding);
});

test("honors Retry-After across slots while responses are bounded", async () => {
  let now = start;
  let calls = 0;
  const reader = createAccountReader(async () => settings, async request => {
    calls++;
    const url = new URL(String(request));
    if (url.pathname.endsWith("/quota")) return new Response(null, { status: 429, headers: { "Retry-After": "180" } });
    return new Response(" ".repeat(512 * 1024 + 1));
  }, () => now);
  const result = await reader(signal);
  assert(result.state === "enabled" && result.quota.state === "rate-limited" && result.today.state === "error");
  now += 179_000;
  await reader(signal);
  assert.equal(calls, 4);
  now += 1_000;
  await reader(signal);
  assert.equal(calls, 8);
});

test("a new binding invalidates projections from a previous in-flight request", async () => {
  let selected = settings;
  let finish!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const oldStarted = new Promise<void>(resolve => { started = resolve; });
  const reader = createAccountReader(async () => selected, async request => {
    const url = new URL(String(request));
    const old = url.pathname.split("/").includes("17");
    if (old) {
      started();
      await gate;
    }
    if (url.pathname.endsWith("/quota")) return json({});
    if (url.search) return json(stats(Number(url.searchParams.get("days"))));
    return json({ id: old ? 17 : 18, platform: "openai", type: "oauth" });
  }, () => start);
  const prior = reader(signal);
  await oldStarted;
  selected = { ...settings, accountId: 18 };
  try {
    assert.equal((await reader(signal)).state, "enabled");
  } finally {
    finish();
  }
  assert.deepEqual(await prior, { state: "error" });
});
