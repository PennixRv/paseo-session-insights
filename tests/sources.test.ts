import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createCchpReader } from "../server/cchp.ts";
import { readCodex } from "../server/codex.ts";
import { createLifecycleCchpReader, projectLifecycleLocalSources } from "../server/lifecycle-cchp.ts";
import { projectCodex, projectGateway } from "../server/usage.ts";
import { readProgress, readTeamwork } from "../server/workflow.ts";

test("Lifecycle CCHP configuration coalesces reads and stops using a revoked token", async () => {
  const signal = new AbortController().signal;
  let now = 0;
  let token: string | null = "fixture-one";
  let reads = 0;
  const sent: string[] = [];
  const read = createLifecycleCchpReader(async () => {
    reads++;
    return token ? { baseUrl: "https://gateway.invalid", apiKeyId: "fixture-key", token } : null;
  }, async (_url, options) => {
    sent.push(new Headers(options?.headers).get("Authorization")!);
    return Response.json({ page: { items: [], nextCursor: null } });
  }, () => now);
  await Promise.all([read("a", signal), read("b", signal)]);
  assert.equal(reads, 1);
  token = "fixture-two";
  now += 15_000;
  await read("a", signal);
  token = null;
  now += 15_000;
  assert.equal(await read("a", signal), undefined);
  assert.deepEqual(sent, ["Bearer fixture-one", "Bearer fixture-one", "Bearer fixture-two"]);
});

test("Lifecycle local sources require the configured daemon home and plug-in profile", () => {
  const values = {
    PENNIX_COMPONENT_PASEO_CLI: "y",
    PENNIX_PASEO_HOME: "$HOME/.paseo",
    PENNIX_PASEO_PLUGIN_PROFILE: "$HOME/pennix/profile.json",
    PENNIX_CODEX_HOME: "$HOME/.codex",
  };
  const home = join(homedir(), ".paseo");
  assert.deepEqual(projectLifecycleLocalSources({ values }, home), { codexHome: join(homedir(), ".codex") });
  assert.equal(projectLifecycleLocalSources({ values }, "/other"), undefined);
  assert.equal(projectLifecycleLocalSources({ values: { ...values, PENNIX_PASEO_PLUGIN_PROFILE: "" } }, home), undefined);
  assert.equal(projectLifecycleLocalSources({ values: { ...values, PENNIX_CODEX_HOME: "$HOME/../other" } }, home), undefined);
});

test("Codex counters use one exact cumulative sample and reject a wrong thread", () => {
  const record = {
    threadId: "a", usageAt: 80, compactionAt: 60,
    usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 37 },
    compactionWindow: 2,
  };
  const projection = projectCodex(record, "a", 100);
  assert.deepEqual(projection.cachedInput, { state: "ready", source: "codex", observedAt: 100, sampleAt: 80, value: 37 });
  assert.deepEqual(projection.cache, projection.cachedInput);
  assert.deepEqual(projection.compactions, { state: "ready", source: "codex", observedAt: 100, sampleAt: 60, value: 2 });
  assert.throws(() => projectCodex(record, "b", 100), /thread mismatch/);
  assert.throws(() => projectCodex({ ...record, usage: { ...record.usage, cached_input_tokens: 101 } }, "a", 100), /cache counters/);
  assert.equal(projectCodex({ threadId: "a", usage: {
    input_tokens: 0, output_tokens: 0, cached_input_tokens: 0,
  } }, "a", 100).cache?.state, "no-records");
});

test("gateway selects one request and sums cleared amounts exactly once", () => {
  const threadId = "a";
  const charge = { id: "one", threadId, settled: true, money: { currency: "USD", amount: "0.1" } };
  const ledger = {
    complete: true,
    requests: [
      { id: "first", threadId, completedAt: 1, streaming: true, ttftMs: 4, tps: 9, basis: "output-tokens" },
      { id: "second", threadId, completedAt: 2, streaming: true, ttftMs: 6 },
      { id: "other", threadId, completedAt: 3, streaming: false, ttftMs: 1 },
    ],
    charges: [charge, charge, { ...charge, id: "two", money: { currency: "USD", amount: "0.2" } },
      { id: "pending", threadId, settled: false }],
  };
  const projection = projectGateway(ledger, threadId, 100, "cchp");
  assert.deepEqual(projection.ttft, { source: "cchp", observedAt: 100, sampleAt: 2, state: "ready", value: 6, basis: "已查请求中最近完成" });
  assert.equal(projection.tps?.sampleAt, projection.ttft?.sampleAt);
  assert.equal(projection.tps?.state, "no-records");
  assert.deepEqual(projection.cost, { source: "cchp", observedAt: 100, state: "partial", value: [{ currency: "USD", amount: "0.3" }] });
  assert.throws(() => projectGateway(ledger, "another", 100, "cchp"), /thread mismatch/);
  assert.throws(() => projectGateway({ ...ledger, charges: [charge, { ...charge, money: { currency: "USD", amount: "10" } }] }, threadId, 100, "cchp"), /Conflicting/);
});

test("Trellis reports only project counts and skips projects without a task directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-insights-"));
  try {
    let calls = 0;
    const run = async (args: string[], cwd: string) => {
      calls++;
      assert.equal(cwd, root);
      assert.deepEqual(args, ["task", "progress", "--json"]);
      return { planning: 0, in_progress: 2, completed: 3, cancelled: 9, partial: true };
    };
    assert.equal((await readProgress(root, run)).planning?.state, "unsupported");
    assert.equal(calls, 0);
    await mkdir(join(root, ".trellis", "tasks"), { recursive: true });
    const current = await readProgress(root, run, () => 20);
    assert.deepEqual(Object.keys(current), ["planning", "inProgress", "completed", "cancelled"]);
    assert.deepEqual(current.planning, {
      state: "partial", value: 0, source: "trellis", observedAt: 20,
    });
    assert.deepEqual(current.cancelled, {
      state: "partial", value: 9, source: "trellis", observedAt: 20,
    });
    const previous = { planning: 0, in_progress: 2, completed: 3 };
    assert.equal((await readProgress(root, async () => previous)).cancelled?.state, "unsupported");
    const zero = await readProgress(root, async () => ({ ...previous, cancelled: 0 }), () => 20);
    assert.deepEqual(zero.cancelled, { state: "ready", value: 0, source: "trellis", observedAt: 20 });
  } finally { await rm(root, { recursive: true }); }
});

test("Teamwork filters the owner, de-duplicates workers and preserves partial coverage", async () => {
  const now = 1_000_000;
  const calls: string[][] = [];
  const data = await readTeamwork("/fixture", "owner", async args => {
    calls.push(args);
    if (args[1] === "list") {
      assert.ok(args.includes("owner"));
      if (args[3] === "global") throw new Error("transient");
      const same = { name: "root", project: "p", ownerSessionId: "owner" };
      return [same, same, { name: "other", project: "p", ownerSessionId: "other" }];
    }
    assert.equal(args[2], "root");
    assert.ok(args.includes("--project-key"));
    const done = { workerId: "d", lifecycle: "done", updatedAt: new Date(now - 29_000).toISOString() };
    return { items: [
      { workerId: "a", lifecycle: "running", activity: "mid-turn" },
      { workerId: "b", lifecycle: "running", activity: "idle" },
      done, done, { ...done, workerId: "old", updatedAt: new Date(now - 30_000).toISOString() },
    ] };
  }, () => now);
  assert.deepEqual(data.ended, { state: "partial", value: 1, source: "teamwork", observedAt: now });
  assert.deepEqual(data.error, { state: "partial", value: 0, source: "teamwork", observedAt: now });
  assert.equal(calls.filter(args => args[1] === "workers").length, 1);
  assert.equal((await readTeamwork("/fixture", "owner", async () => [], () => now)).idle?.state, "ready");
});

test("Codex adapter follows only the indexed thread and projects known metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-codex-fixture-"));
  const signal = new AbortController().signal;
  try {
    await mkdir(join(home, "sessions"));
    const indexed = join(home, "sessions", "rollout-fixture.jsonl");
    const misplaced = join(home, "private.jsonl");
    const db = new DatabaseSync(join(home, "state_5.sqlite"));
    try {
      db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, archived INT)");
      const insert = db.prepare("INSERT INTO threads VALUES (?, ?, 0)");
      insert.run("thread-a", indexed);
      insert.run("thread-b", indexed);
      insert.run("outside", misplaced);
    } finally { db.close(); }
    const event = (type: string, payload: object) => JSON.stringify({ timestamp: "2026-11-24T01:30:00Z", type, payload });
    const contents = [
      event("session_meta", { id: "thread-a", base_instructions: "test-only system text" }),
      event("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 30, cached_input_tokens: 40 } } }),
      event("response_item", { type: "message", content: [{ type: "compacted", payload: { window_number: 90 } }] }),
      event("compacted", { history: [{ window_number: 99, text: "test-only nested content" }], window_number: 2 }),
    ];
    await writeFile(indexed, `${contents.join("\n")}\n`);
    await writeFile(misplaced, `${contents[0]}\n`);
    const reading = await readCodex(home, "thread-a", signal);
    assert.deepEqual(Object.values(reading).map(value => "value" in value ? value.value : value.state), [100, 30, 40, 40, 2]);
    assert.doesNotMatch(JSON.stringify(reading), /test-only/);
    assert.equal((await readCodex(home, "thread-b", signal)).input?.state, "unlinked");
    assert.equal((await readCodex(home, "outside", signal)).input?.state, "forbidden");
    await writeFile(indexed, `${contents.join("\n")}\n${event("event_msg", { type: "thread_rolled_back" })}\n`);
    assert.equal((await readCodex(home, "thread-a", signal)).compactions?.state, "no-records");
    const longResponse = event("response_item", { type: "message", text: " ".repeat(3 * 1024 * 1024) });
    const oldCompaction = `${contents.join("\n")}\n${longResponse}\n`;
    await writeFile(indexed, oldCompaction);
    const recovered = await readCodex(home, "thread-a", signal);
    assert.equal(recovered.compactions?.state, "ready");
    assert.equal(recovered.compactions && "value" in recovered.compactions && recovered.compactions.value, 2);
    assert.equal(recovered.cachedInput?.state, "ready");
    assert.equal(recovered.compactions?.sampleAt, Date.parse("2026-11-24T01:30:00Z"));
    await writeFile(indexed, `${oldCompaction}${event("event_msg", { type: "thread_rolled_back" })}\n`);
    assert.equal((await readCodex(home, "thread-a", signal)).compactions?.state, "no-records");
    const scopedContents = [
      event("session_meta", { account_scoped: true, creator_user_id: "fixture", creator_account_id: "fixture",
        session_id: "thread-a", id: "thread-a", base_instructions: "test-only system text" }),
      ...contents.slice(1),
    ].map((line, ordinal) => line.replace(',"type":', `,"ordinal":${ordinal},"type":`));
    await writeFile(indexed, `${scopedContents.join("\n")}\n`);
    assert.deepEqual(Object.values(await readCodex(home, "thread-a", signal)).map(value =>
      "value" in value ? value.value : value.state), [100, 30, 40, 40, 2]);
    await writeFile(indexed, `${scopedContents.join("\n").replace('"id":"thread-a"', '"id":"thread-b"')}\n`);
    assert.equal((await readCodex(home, "thread-a", signal)).input?.state, "unlinked");
  } finally { await rm(home, { recursive: true }); }
});

test("CCHP adapter queries exact thread and key and rejects other rows", async () => {
  const signal = new AbortController().signal;
  const opts = { baseUrl: "https://gateway.invalid/", token: "fixture-key", apiKeyId: "key1" };
  const old = {
    requestId: "old", sessionId: "thread", apiKeyId: "key1", completedAt: "2026-11-24T02:00:00Z",
    streaming: true, ttftMs: 400, tpsMilli: 42000, tpsBasis: "ttft", costUnits: 5000000001, adjustedCostUnits: null,
  };
  let calls = 0;
  const read = createCchpReader(opts, async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/account/usage/logs");
    assert.equal(url.searchParams.get("sessionId"), "thread");
    assert.equal(url.searchParams.get("apiKeyIds"), "key1");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    const latest = { ...old, requestId: "latest", completedAt: "2026-11-24T02:01:00Z",
      ttftMs: 1234, tpsMilli: null, adjustedCostUnits: 3 };
    const nonstream = { ...old, requestId: "nonstream", streaming: false, costUnits: 10 };
    const pending = { ...old, requestId: "pending", completedAt: null };
    return Response.json({ page: url.searchParams.has("cursor") ?
      { items: [latest, old, nonstream, pending], nextCursor: null } : { items: [old], nextCursor: "next" } });
  });
  const reading = await read("thread", signal);
  assert.equal(calls, 2);
  assert.equal("value" in reading.ttft! && reading.ttft.value, 1234);
  assert.equal(reading.tps?.state, "no-records");
  assert.equal(reading.cost?.state, "partial");
  assert.deepEqual("value" in reading.cost! && reading.cost.value, [{ currency: "CRED", amount: "0.5000000014" }]);
  const wrong = createCchpReader(opts, async () => Response.json({
    page: { items: [{ ...old, sessionId: "different" }], nextCursor: null },
  }));
  assert.equal((await wrong("thread", signal)).ttft?.state, "unlinked");
});

test("gateway throttling and denied access clear rather than reuse an old reading", async () => {
  const signal = new AbortController().signal;
  const opts = { baseUrl: "https://gateway.invalid/", token: "fixture-key", apiKeyId: "key1" };
  let calls = 0;
  let time = 10_000;
  const read = createCchpReader(opts, async () => {
    calls++;
    return calls === 1
      ? new Response(null, { status: 429, headers: { "Retry-After": "2" } })
      : new Response(null, { status: 403 });
  }, () => time);
  assert.equal((await read("thread", signal)).ttft?.state, "rate-limited");
  assert.equal((await read("thread", signal)).tps?.state, "rate-limited");
  assert.equal(calls, 1);
  time += 2000;
  assert.equal((await read("thread", signal)).ttft?.state, "forbidden");
  assert.equal(calls, 2);
});

test("CCHP totals the session beyond three pages and refreshes performance between cost scans", async () => {
  const signal = new AbortController().signal;
  const opts = { baseUrl: "https://gateway.invalid", token: "fixture-key", apiKeyId: "key1" };
  let clock = 60_000;
  let pages = 0;
  const read = createCchpReader(opts, async input => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("cursor") ?? 0);
    pages++;
    return Response.json({ page: {
      nextCursor: page < 4 ? String(page + 1) : null,
      items: [{
        requestId: `request-${page}`, sessionId: "thread", apiKeyId: "key1",
        completedAt: new Date(clock - page).toISOString(), streaming: true,
        ttftMs: clock, tpsMilli: 42000, tpsBasis: "ttfb",
        costUnits: 10_000_000_000, adjustedCostUnits: null,
      }],
    } });
  }, () => clock);
  const first = await read("thread", signal);
  assert.equal(pages, 5);
  assert.deepEqual(first.cost, {
    source: "cchp", observedAt: 60_000, state: "ready",
    value: [{ currency: "CRED", amount: "5" }],
  });
  clock += 15_000;
  const second = await read("thread", signal);
  assert.equal(pages, 8);
  assert.deepEqual(second.cost, first.cost);
  assert.equal("value" in second.ttft! && second.ttft.value, clock);
  assert.equal(second.ttft?.state, "ready");
  assert.equal(second.tps && "basis" in second.tps && second.tps.basis, "最近 3 条请求中最近完成 · 按首字节计时");
  clock += 45_000;
  const next = await read("thread", signal);
  assert.equal(next.cost && "observedAt" in next.cost && next.cost.observedAt, clock);
  assert.equal(pages, 13);
});

test("CCHP resumes billing past 2,000 requests and checks the newest stream separately", async () => {
  const signal = new AbortController().signal;
  const opts = { baseUrl: "https://gateway.invalid", token: "fixture-key", apiKeyId: "key1" };
  let clock = 60_000;
  const deepPages: number[] = [];
  let rateLimited = false;
  const read = createCchpReader(opts, async input => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    const cutoff = url.searchParams.get("end");
    if (cutoff) {
      assert.equal(cutoff, new Date(60_000).toISOString());
      deepPages.push(offset);
      if (offset === 2000 && !rateLimited) {
        rateLimited = true;
        return new Response(null, { status: 429, headers: { "Retry-After": "1" } });
      }
    }
    const limit = Number(url.searchParams.get("limit"));
    const end = Math.min(offset + limit, 2031);
    return Response.json({ page: {
      nextCursor: end < 2031 ? String(end) : null,
      items: Array.from({ length: end - offset }, (_, index) => {
        // The final page overlaps the previous one by one record.
        const ordinal = Math.max(0, offset + index - (offset >= 2000 ? 1 : 0));
        return {
          requestId: `req-${ordinal}`, sessionId: "thread", apiKeyId: "key1",
          completedAt: new Date(clock - ordinal).toISOString(), streaming: true,
          ttftMs: clock, tpsMilli: 42_000, tpsBasis: "ttfb",
          costUnits: 10_000_000_000, adjustedCostUnits: null,
        };
      }),
    } });
  }, () => clock);
  const partial = (await read("thread", signal)).cost;
  assert.equal(partial?.state, "partial");
  assert.equal(partial.hasMoreBilling, true);
  assert.deepEqual("value" in partial && partial.value, [{ currency: "CRED", amount: "2000" }]);
  clock += 15_000;
  const throttled = (await read("thread", signal)).cost;
  assert.equal(throttled?.state, "rate-limited");
  assert.equal(throttled?.hasMoreBilling, true);
  assert.equal(throttled?.retryAt, clock + 1000);
  assert.equal((await read("thread", signal)).cost?.state, "rate-limited");
  clock += 600_000;
  const final = await read("thread", signal);
  assert.deepEqual(deepPages, [...Array.from({ length: 10 }, (_, i) => i * 200), 2000, 2000]);
  assert.deepEqual(final.cost, { source: "cchp", observedAt: clock, state: "ready",
    value: [{ currency: "CRED", amount: "2030" }] });
  assert.equal(final.ttft && "value" in final.ttft && final.ttft.value, clock);
});

test("CCHP ends pagination on the final page while the amount stays partial", async () => {
  const reader = createCchpReader({ baseUrl: "https://gateway.invalid", token: "fixture-key", apiKeyId: "key1" },
    async () => Response.json({ page: { nextCursor: null, totalIsLowerBound: true, items: [
      { requestId: "settled", sessionId: "thread", apiKeyId: "key1", completedAt: new Date(1).toISOString(),
        streaming: false, adjustedCostUnits: 25_000_000_000 },
      { requestId: "pending", sessionId: "thread", apiKeyId: "key1", completedAt: null, streaming: true },
    ] } }), () => 2);
  const { cost } = await reader("thread", new AbortController().signal);
  assert.deepEqual(cost, { source: "cchp", observedAt: 2, state: "partial",
    value: [{ currency: "CRED", amount: "2.5" }] });
});
