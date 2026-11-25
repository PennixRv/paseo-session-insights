import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccountView } from "../client/account-state.ts";
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
  const lifetime = new AbortController();
  const view = createAccountView(lifetime.signal, () => now);
  const otherDaemon = createAccountView(lifetime.signal, () => now);
  await view.refresh(async () => account, false);
  view.showAccount = true;
  now += 45_000;
  assert.equal(view.snapshot(), account);
  assert.equal(view.showAccount, true);
  assert.equal(view.refreshDelay(), 15_000);
  const unexpected = async () => assert.fail("A remount must use the still-fresh daemon snapshot");
  assert.equal(await view.refresh(unexpected, true), account);
  assert.equal(await view.refresh(unexpected, false), account);
  assert.equal(otherDaemon.snapshot(), undefined);
  assert.equal(otherDaemon.showAccount, false);
  now += 15_000;
  assert.deepEqual(view.snapshot(), { state: "available" });
  assert.deepEqual(await view.refresh(async () => ({ state: "forbidden" }), false), { state: "forbidden" });
  assert.deepEqual(view.snapshot(), { state: "forbidden" });
  lifetime.abort();
  assert.equal(view.snapshot(), undefined);
});

test("a delayed status-only response cannot overwrite a new account snapshot", async () => {
  const view = createAccountView(new AbortController().signal);
  let finish!: (value: AccountSnapshot) => void;
  const status = new Promise<AccountSnapshot>(resolve => { finish = resolve; });
  const previous = view.refresh(() => status, true);
  await view.refresh(async () => account, false);
  finish({ state: "available" });
  await previous;
  assert.equal(view.snapshot(), account);
});
