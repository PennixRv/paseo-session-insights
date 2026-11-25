import assert from "node:assert/strict";
import { test } from "node:test";
import { findFocusedAgent } from "../client/focus.ts";
import { createSession } from "../client/session.ts";
import { fixtureSnapshot } from "../server/fixture.ts";
import { createSnapshotHandler, type Subject } from "../server/snapshot.ts";
import { formatAccountTime, formatMetric } from "../shared/format.ts";
import { detailGroups, emptySnapshot, metricIds, snapshotSchema, targetSchema } from "../shared/metrics.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("both surfaces keep the same 16 metrics, units and groups", () => {
  const fixture = snapshotSchema.parse(fixtureSnapshot(100));
  assert.deepEqual(detailGroups.flatMap(group => [...group.ids]), [...metricIds]);
  assert.deepEqual(metricIds.map(id => formatMetric(id, fixture.metrics[id], true)),
    ["25.90M", "1.34M", "22.53M", "87%", "12", "4.28 USD", "1.2s", "46 tok/s", "3", "1", "12", "2", "2", "1", "0", "1"]);
  assert.equal(formatMetric("cost", { state: "partial", value: [{ amount: "2.34", currency: "CRED" }] }, true), "2.34 CRED");
  assert.equal(formatMetric("input", fixture.metrics.input), "25.90M");
  assert.equal(formatMetric("cache", fixture.metrics.cache), "87.00%");
  assert.equal(formatMetric("cost", fixture.metrics.cost), "4.28 USD");
  assert.equal(formatMetric("tps", fixture.metrics.tps), "46 tok/s");
});

test("account times use one local format and preserve date-only precision", () => {
  const time = new Date(2026, 11, 18, 9, 5);
  assert.equal(formatAccountTime(time.toISOString()), "12/18 09:05");
  assert.equal(formatAccountTime(time.getTime() / 1000), "12/18 09:05");
  assert.equal(formatAccountTime("2026-12-18"), "12/18");
  assert.equal(formatAccountTime(null), "—");
});

test("formatter distinguishes missing, tiny values and zero", () => {
  assert.equal(formatMetric("working", { state: "waiting" }, true), "—");
  assert.equal(formatMetric("working", { state: "ready", value: 0 }, true), "0");
  assert.equal(formatMetric("cost", { state: "ready", value: [{ currency: "USD", amount: "0.00001" }] }, true), "<0.01 USD");
  const credits = emptySnapshot("waiting");
  credits.metrics.cost = { state: "partial", value: [{ currency: "CRED", amount: "0.5000000014" }] };
  assert.equal(snapshotSchema.safeParse(credits).success, true);
  assert.equal(formatMetric("cost", credits.metrics.cost, true), "0.50 CRED");
  assert.equal(formatMetric("cost", credits.metrics.cost), "0.5000000014 CRED");
  assert.equal(formatMetric("cache", { state: "ready", value: 99.999 }, true), ">99.99%");
  assert.equal(formatMetric("input", { state: "ready", value: 50 }, true), "<0.01M");
  assert.equal(formatMetric("input", { state: "ready", value: 251_070_000 }, true), "251.07M");
  assert.equal(formatMetric("output", { state: "ready", value: 0 }, true), "0.00M");
  assert.equal(formatMetric("cachedInput", { state: "ready", value: 10_000_000_000 }, true), "10000.00M");
  assert.equal(formatMetric("cost", { state: "partial", value: [{ currency: "USD", amount: "1.23" }, { currency: "EUR", amount: "2" }] }, true), "多币种");
  assert.equal(targetSchema.safeParse({ workspaceId: "w", agentId: "a", threadId: "untrusted" }).success, false);
  const invalid = emptySnapshot("waiting");
  invalid.metrics.cache = { state: "ready", value: 103 };
  assert.equal(snapshotSchema.safeParse(invalid).success, false);
});

test("desktop requests share one fetch and reject old thread responses after invalidation", async () => {
  const first = deferred<ReturnType<typeof fixtureSnapshot>>();
  const second = deferred<ReturnType<typeof fixtureSnapshot>>();
  const pending = [first, second];
  let calls = 0;
  const session = createSession(() => pending[calls++].promise);
  const detach = session.attach();
  const a = session.refresh();
  const b = session.refresh();
  assert.equal(a, b);
  await Promise.resolve();
  session.invalidate();
  const next = session.refresh();
  first.resolve(fixtureSnapshot(1));
  await a;
  assert.equal(session.current().metrics.input.state, "loading");
  second.resolve(fixtureSnapshot(2));
  await next;
  assert.equal(session.current().metrics.input.observedAt, 2);
  assert.equal(calls, 2);
  detach();
  session.invalidate();
  await Promise.resolve();
  assert.equal(calls, 2);
  session.dispose();
});

test("visible sessions poll while running, settle once and pause when idle or hidden", async ({ mock }) => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const reads: number[] = [];
  const session = createSession(async () => {
    reads.push(Date.now());
    return fixtureSnapshot(Date.now());
  });
  const flush = async (elapsed = 0) => {
    mock.timers.tick(elapsed);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  session.setForeground(true);
  const detach = session.attach();
  await flush();
  await flush(30_000);
  assert.deepEqual(reads, [1_000]);

  session.setRunning(true);
  await flush();
  await flush(15_000);
  assert.deepEqual(reads, [1_000, 31_000, 46_000]);
  await flush(12_000);
  session.setRunning(false);
  await flush(4_999);
  assert.equal(reads.length, 3);
  await flush(1);
  assert.deepEqual(reads, [1_000, 31_000, 46_000, 63_000]);
  await flush(60_000);
  assert.equal(reads.length, 4);
  assert.equal(session.current().metrics.input.observedAt, 63_000);

  await session.refresh();
  assert.equal(reads.length, 5);
  session.setForeground(false);
  session.setRunning(true);
  await flush(30_000);
  assert.equal(reads.length, 5);
  session.setForeground(true);
  await flush();
  assert.equal(reads.length, 6);
  detach();
  await flush(30_000);
  assert.equal(reads.length, 6);
  session.dispose();
});

test("manual refresh immediately starts one read even just after an automatic refresh", async () => {
  const response = deferred<ReturnType<typeof fixtureSnapshot>>();
  let reads = 0;
  const session = createSession(() => ++reads === 1 ? Promise.resolve(fixtureSnapshot(1)) : response.promise,
    () => 1_000);
  session.setForeground(true);
  const detach = session.attach();
  try {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.equal(session.current().metrics.input.observedAt, 1);
    const pending = session.refresh();
    assert.equal(session.status().reading, true);
    assert.equal(session.refresh(), pending);
    await Promise.resolve();
    assert.equal(reads, 2);
    response.resolve(fixtureSnapshot(2));
    await pending;
    assert.equal(session.current().metrics.input.observedAt, 2);
    assert.equal(session.status().reading, false);
  } finally {
    detach();
    session.dispose();
  }
});

test("details continue billing at the allowed interval and stop at end, close, background or thread change", async ({ mock }) => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const reads: number[] = [];
  let pages: "more" | "complete" = "more";
  let rateLimited = false;
  const session = createSession(async () => {
    reads.push(Date.now());
    const snapshot = fixtureSnapshot(Date.now());
    const hasMoreBilling = pages === "more" ? true : undefined;
    snapshot.metrics.cost = rateLimited
      ? { state: "rate-limited", hasMoreBilling, retryAt: Date.now() + 45_000 }
      : { ...snapshot.metrics.cost, hasMoreBilling };
    return snapshot;
  });
  const tick = async (ms: number) => {
    mock.timers.tick(ms);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  session.setForeground(true);
  const detach = session.attach();
  await tick(0);
  assert.deepEqual(session.status(), { running: false, continuing: false, reading: false });
  session.continueBilling();
  rateLimited = true;
  await tick(15_000);
  assert.equal(session.status().continuing, true);
  await tick(44_999);
  assert.deepEqual(reads, [1_000, 16_000]);
  rateLimited = false;
  pages = "complete";
  await tick(1);
  assert.equal(session.status().continuing, false);
  assert.equal(session.current().metrics.cost.hasMoreBilling, undefined);
  session.continueBilling();
  await tick(60_000);
  assert.deepEqual(reads, [1_000, 16_000, 61_000]);

  pages = "more";
  await session.refresh();
  await tick(0);
  session.continueBilling();
  session.stopBilling();
  await tick(30_000);
  assert.equal(reads.length, 4);
  session.continueBilling();
  session.setForeground(false);
  await tick(30_000);
  assert.equal(reads.length, 4);
  session.setForeground(true);
  await tick(0);
  session.continueBilling();
  session.invalidate();
  await tick(0);
  await tick(30_000);
  assert.equal(reads.length, 6);
  session.continueBilling();
  detach();
  await tick(30_000);
  assert.equal(reads.length, 6);
  session.dispose();
});

test("left sidebar follows a unique focused handle and hides unmatched or ambiguous readings", () => {
  type Composers = Parameters<typeof findFocusedAgent>[0];
  type Handle = ReturnType<Composers>[number];
  const a = { context: "agent" } as Handle;
  const b = { ...a };
  const handles = new Map([["a", a], ["b", b]]);
  let focused: Handle | undefined;
  const composers: Composers = selector => {
    const handle = "focused" in selector ? focused : handles.get(selector.agentId);
    return handle ? [handle] : [];
  };
  assert.equal(findFocusedAgent(composers, handles.keys()), null);
  focused = a;
  assert.equal(findFocusedAgent(composers, handles.keys()), "a");
  focused = b;
  assert.equal(findFocusedAgent(composers, handles.keys()), "b");
  focused = { ...b };
  assert.equal(findFocusedAgent(composers, handles.keys()), null);
  focused = a;
  handles.set("b", a);
  assert.equal(findFocusedAgent(composers, handles.keys()), null);
});

test("daemon coalesces the same subject and discards an in-flight result after a fork", async () => {
  const entered = deferred<void>();
  const result = deferred<ReturnType<typeof fixtureSnapshot>>();
  let calls = 0;
  const handler = createSnapshotHandler(async () => {
    calls++;
    entered.resolve();
    return await result.promise;
  });
  const target = { workspaceId: "w", agentId: "a" };
  const current: Subject = { ...target, serverId: "s", workspaceRoot: "/fixture", threadId: "a" };
  const resolve = async () => ({ ...current });
  const first = handler.read(target, resolve);
  const same = handler.read(target, resolve);
  await entered.promise;
  current.threadId = "b";
  result.resolve(fixtureSnapshot(3));
  assert.equal((await first).metrics.input.state, "unlinked");
  assert.equal((await same).metrics.input.state, "unlinked");
  assert.equal(calls, 1);
  handler.stop();
  assert.equal((await handler.read(target, resolve)).metrics.input.state, "error");
});

test("a workspace mismatch yields no reads and independent hosts do not share results", async () => {
  const target = { workspaceId: "w", agentId: "a" };
  let calls = 0;
  const handler = createSnapshotHandler(async subject => {
    calls++;
    return fixtureSnapshot(subject.serverId === "s1" ? 1 : 2);
  });
  assert.equal((await handler.read(target, async () => null)).metrics.input.state, "unlinked");
  assert.equal(calls, 0);
  const snapshots = await Promise.all(["s1", "s2"].map(serverId => handler.read(target, async () => ({
    ...target, serverId, workspaceRoot: "/fixture", threadId: "t",
  }))));
  assert.deepEqual(snapshots.map(s => s.metrics.input.observedAt), [1, 2]);
});

test("a cleaned-up client does not dispatch an already queued refresh", async () => {
  let calls = 0;
  const session = createSession(async () => {
    calls++;
    return fixtureSnapshot(1);
  });
  const pending = session.refresh();
  session.dispose();
  await pending;
  assert.equal(calls, 0);
});
