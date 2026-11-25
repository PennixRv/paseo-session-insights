import type { AccountSnapshot } from "../shared/account.ts";

const accountRefreshMs = 60_000;
type Read = (statusOnly: boolean) => Promise<AccountSnapshot>;
const available: AccountSnapshot = { state: "available" };

export function createAccountView(lifetime: AbortSignal, clock = Date.now) {
  let value: AccountSnapshot | undefined;
  let expiresAt = 0;
  let pending: { statusOnly: boolean; result: Promise<AccountSnapshot | undefined> } | undefined;
  let revision = 0;

  const snapshot = () => lifetime.aborted ? undefined :
    value?.state === "enabled" && clock() >= expiresAt ? available : value;

  return {
    showAccount: false,
    snapshot,
    refreshDelay: () => value?.state === "enabled" && clock() < expiresAt
      ? expiresAt - clock() : accountRefreshMs,
    refresh(read: Read, statusOnly: boolean) {
      if (lifetime.aborted) return Promise.resolve(undefined);
      if (pending && (!pending.statusOnly || statusOnly)) return pending.result;
      if (clock() < expiresAt && value?.state === "enabled") return Promise.resolve(value);
      const request = ++revision;
      const result = Promise.resolve().then(() => read(statusOnly)).catch((): AccountSnapshot => ({ state: "error" }))
        .then(next => {
          if (lifetime.aborted || request !== revision) return snapshot();
          if (next.state === "available" && value?.state === "enabled") return snapshot();
          value = next;
          expiresAt = clock() + accountRefreshMs;
          return snapshot();
        }).finally(() => { if (request === revision) pending = undefined; });
      pending = { statusOnly, result };
      return result;
    },
  };
}

export type AccountView = ReturnType<typeof createAccountView>;
