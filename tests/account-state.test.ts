import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccountCache } from "../client/account-state.ts";
import type { AccountSnapshot } from "../shared/account.ts";

const account = {
  state: "enabled",
  quota: { state: "ready", data: { window: { used: 42, resetAt: 900 }, cards: null } },
  subscription: { state: "ready", data: null },
  today: { state: "ready", data: { tokens: 620000, cost: 0.25, requests: 6, cache: 50 } },
  week: { state: "error" },
} satisfies AccountSnapshot;

test("a remounted footer immediately restores the same daemon's account view and avoids a duplicate read", async () => {
  let now = 100;
  let calls = 0;
  const cache = createAccountCache(() => now);
  const view = cache.attach(async only => only ? { state: "available" } : ++calls === 1 ? account : { state: "forbidden" });
  const otherDaemon = cache.attach(async () => account);
  await view.refresh(false);
  view.showAccount = true;
  now += 45_000;
  assert.equal(view.snapshot(), account);
  assert.equal(view.showAccount, true);
  assert.equal(view.refreshDelay(), 15_000);
  assert.equal(await view.refresh(true), account);
  assert.equal(await view.refresh(false), account);
  assert.equal(calls, 1);
  assert.equal(otherDaemon.snapshot(), undefined);
  assert.equal(otherDaemon.showAccount, false);
  now += 15_000;
  assert.equal(view.snapshot(), account);
  assert.deepEqual(await view.refresh(false), { state: "forbidden" });
  assert.deepEqual(view.snapshot(), { state: "forbidden" });
  view.dispose();
  assert.equal(view.snapshot(), undefined);
});

test("a cold refresh waits for a pending status check then publishes the full snapshot", async () => {
  let finish!: (value: AccountSnapshot) => void;
  const status = new Promise<AccountSnapshot>(resolve => { finish = resolve; });
  const view = createAccountCache().attach(async only => only ? status : account);
  const previous = view.probe();
  const full = view.refresh(false);
  finish({ state: "available" });
  await previous;
  await full;
  assert.equal(view.snapshot(), account);
});

test("the first frame on another verified daemon shows the same account during refresh", async () => {
  let now = 100;
  const cache = createAccountCache(() => now);
  const binding = "a".repeat(64);
  const source = { ...account, binding };
  let reads = 0;
  const first = cache.attach(async only => only ? { state: "available", binding } : (++reads, source));
  let finish!: (value: AccountSnapshot) => void;
  const pending = new Promise<AccountSnapshot>(resolve => { finish = resolve; });
  const second = cache.attach(async statusOnly => statusOnly ? { state: "available", binding } : pending);
  const unrelated = cache.attach(async () => ({ state: "available", binding: "b".repeat(64) }));
  const unknown = cache.attach(async () => ({ state: "available" }));
  await Promise.all([second.probe(), unrelated.probe(), unknown.probe()]);
  await first.refresh(false);
  first.showAccount = true;
  assert.equal(second.snapshot(), source);
  assert.equal(second.showAccount, true);
  assert.equal(unrelated.snapshot()?.state, "available");
  assert.equal(unknown.snapshot()?.state, "available");

  now += 60_000;
  const refresh = second.refresh(false);
  assert.equal(second.snapshot(), source);
  finish({ state: "forbidden", binding });
  await refresh;
  assert.equal(first.snapshot()?.state, "forbidden");
  assert.equal(second.snapshot()?.state, "forbidden");
  assert.equal((await first.refresh(false))?.state, "forbidden");
  assert.equal(reads, 1);
});

test("rebinding and unload discard access to the previous account", async () => {
  let now = 100;
  const cache = createAccountCache(() => now);
  const source = { ...account, binding: "a".repeat(64) };
  const first = cache.attach(async () => source);
  let binding = source.binding;
  const second = cache.attach(async () => ({ state: "available", binding }));
  await first.refresh(false);
  await second.probe();
  first.dispose();
  assert.equal(second.snapshot(), source);
  now += 60_000;
  binding = "b".repeat(64);
  await second.probe();
  assert.equal(second.snapshot()?.state, "available");
  second.dispose();
  assert.equal(second.snapshot(), undefined);
});
