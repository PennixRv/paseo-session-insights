import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldGlyphs } from "../client/glyphs.ts";
import { createSession } from "../client/session.ts";
import { fixtureSnapshot } from "../server/fixture.ts";
import { createSnapshotHandler, type Subject } from "../server/snapshot.ts";
import { formatMetric, formatSummary } from "../shared/format.ts";
import { detailGroups, emptySnapshot, metricIds, snapshotSchema, summaryGroups, targetSchema } from "../shared/metrics.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("both surfaces keep the same 14 metrics, legacy icon shapes, units and groups", () => {
  const fixture = snapshotSchema.parse(fixtureSnapshot(100));
  assert.deepEqual(detailGroups.flatMap(group => [...group.ids]), [...metricIds]);
  assert.deepEqual(summaryGroups.flatMap(group => [...group.ids]), [...metricIds]);
  assert.deepEqual(formatSummary(fixture).map(group => group.label),
    ["25.9M/1.34M†", "87%·12·4.28$", "1.2s·46t/s", "3/1/12", "2/1/0/1"]);
  assert.deepEqual(Object.keys(fieldGlyphs), [...metricIds]);
  assert.deepEqual(Object.values(fieldGlyphs).map(glyph => glyph.codePointAt(0)),
    [0xF021A, 0xF021A, 0xF0CFF, 0xF1B8, 0xF0584, 0xEF0C, 0xF04C5, 0xF0EA6, 0xF0EA6, 0xF0EA6,
      0xF01D, 0xF192, 0xF29C, 0xF05D]);
  assert.equal(formatMetric("input", fixture.metrics.input), "25.90M");
  assert.equal(formatMetric("cache", fixture.metrics.cache), "87.00%");
  assert.equal(formatMetric("cost", fixture.metrics.cost), "4.28 USD");
  assert.equal(formatMetric("tps", fixture.metrics.tps), "46 tok/s");
});

test("formatter distinguishes missing, tiny values and zero", () => {
  assert.equal(formatMetric("working", { state: "waiting" }, true), "—");
  assert.equal(formatMetric("working", { state: "ready", value: 0 }, true), "0");
  assert.equal(formatMetric("cost", { state: "ready", value: [{ currency: "USD", amount: "0.00001" }] }, true), "<0.01$");
  assert.equal(formatMetric("cache", { state: "ready", value: 99.999 }, true), ">99.99%");
  assert.equal(formatMetric("input", { state: "ready", value: 50 }, true), "<.01M");
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
  const owner = Symbol();
  const unmountOwner = session.attach(owner);
  assert.equal(session.current().owner, owner);
  const a = session.refresh();
  const b = session.refresh();
  assert.equal(a, b);
  await Promise.resolve();
  session.setOpen(true);
  session.invalidate();
  assert.equal(session.current().open, false);
  const next = session.refresh();
  first.resolve(fixtureSnapshot(1));
  await a;
  assert.equal(session.current().snapshot.metrics.input.state, "loading");
  second.resolve(fixtureSnapshot(2));
  await next;
  assert.equal(session.current().snapshot.metrics.input.observedAt, 2);
  assert.equal(calls, 2);
  const alternate = Symbol();
  session.attach(alternate);
  unmountOwner();
  assert.equal(session.current().owner, alternate);
  session.dispose();
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
