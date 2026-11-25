import type { AccountSnapshot } from "../shared/account.ts";

const refreshMs = 60_000;
type Read = (statusOnly: boolean) => Promise<AccountSnapshot>;
type Reading = {
  value?: AccountSnapshot;
  checkedAt: number;
  showAccount: boolean;
  members: number;
  pending?: Promise<void>;
};
const available: AccountSnapshot = { state: "available" };
const blank = (): Reading => ({ checkedAt: 0, showAccount: false, members: 0 });

export function createAccountCache(clock = Date.now) {
  const accounts = new Map<string, Reading>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };

  return {
    attach(read: Read) {
      const local = blank();
      let binding: string | undefined;
      let reading = local;
      let disposed = false;
      let verifiedAt = -Infinity;
      let pending: Promise<void> | undefined;
      let checking: Promise<AccountSnapshot | undefined> | undefined;
      const snapshot = () => {
        if (disposed) return undefined;
        if (reading.value?.state === "enabled" && clock() >= reading.checkedAt + 2 * refreshMs) return available;
        return reading.value ?? local.value;
      };
      function rebind(next: string | undefined) {
        if (binding === next) return;
        if (binding && --reading.members === 0) accounts.delete(binding);
        binding = next;
        reading = local;
        local.value = undefined;
        if (binding) {
          reading = accounts.get(binding) ?? blank();
          reading.members++;
          accounts.set(binding, reading);
        }
      }
      function apply(next: AccountSnapshot) {
        if (disposed) return;
        const nextBinding = "binding" in next ? next.binding : undefined;
        rebind(nextBinding);
        verifiedAt = clock();
        if (next.state === "available") {
          local.value = next;
        } else if (next.state !== "enabled" || reading.value?.state !== "forbidden" ||
            verifiedAt >= reading.checkedAt + refreshMs) {
          reading.value = next;
          reading.checkedAt = verifiedAt;
        }
        notify();
      }
      async function load(statusOnly: boolean) {
        try {
          apply(await read(statusOnly));
        } catch {
          apply({ state: "error" });
        }
      }
      function probe() {
        if (disposed) return Promise.resolve();
        if (checking) return checking.then(() => {});
        return pending ??= load(true).finally(() => { pending = undefined; });
      }
      return {
        snapshot,
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        get showAccount() { return reading.showAccount; },
        set showAccount(value: boolean) {
          reading.showAccount = value;
          notify();
        },
        probe,
        refreshDelay: () => {
          if (reading.value?.state !== "enabled") return refreshMs;
          const due = Math.min(reading.checkedAt, verifiedAt) + refreshMs - clock();
          return due > 0 ? due : refreshMs;
        },
        refresh(statusOnly: boolean) {
          if (disposed) return Promise.resolve(undefined);
          if (statusOnly) {
            return (clock() < verifiedAt + refreshMs ? Promise.resolve() : probe()).then(snapshot);
          }
          return checking ??= (async () => {
            await pending;
            if (disposed) return;
            if (clock() >= verifiedAt + refreshMs) await load(true);
            if (disposed) return;
            if (clock() < reading.checkedAt + refreshMs &&
                (reading.value?.state === "enabled" || reading.value?.state === "forbidden")) {
              return snapshot();
            }
            if (snapshot()?.state === "disabled" || snapshot()?.state === "missing-key") return snapshot();
            const selected = reading;
            await (selected.pending ??= load(false).finally(() => { selected.pending = undefined; }));
            return snapshot();
          })().finally(() => { checking = undefined; });
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          rebind(undefined);
          notify();
        },
      };
    },
  };
}

// Paseo evaluates one bundle per daemon. The binding shares readings only within this app runtime.
const cacheKey = Symbol.for("paseo-session-insights/account-cache/v1");
const app = globalThis as typeof globalThis & { [cacheKey]?: ReturnType<typeof createAccountCache> };
export const accountCache = app[cacheKey] ??= createAccountCache();
export type AccountView = ReturnType<typeof accountCache.attach>;
