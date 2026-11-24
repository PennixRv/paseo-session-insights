import { emptySnapshot, type Snapshot } from "../shared/metrics.ts";

export function createSession(read: () => Promise<Snapshot>, clock = Date.now) {
  let current = { snapshot: emptySnapshot("loading"), open: false, owner: null as symbol | null };
  const listeners = new Set<() => void>();
  const mounted = new Set<symbol>();
  let generation = 0;
  let nextReadAt = 0;
  let inFlight: Promise<void> | undefined;
  let disposed = false;

  function publish(change: Partial<typeof current>) {
    current = { ...current, ...change };
    for (const listener of listeners) listener();
  }

  function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    if (disposed || clock() < nextReadAt) return Promise.resolve();
    const expected = generation;
    nextReadAt = clock() + 15_000;
    const request = Promise.resolve().then(async () => {
      if (disposed || expected !== generation) return;
      const snapshot = await read();
      if (!disposed && expected === generation) publish({ snapshot });
    }).catch(() => {
      if (!disposed && expected === generation) publish({ snapshot: emptySnapshot("error") });
    }).finally(() => {
      if (inFlight === request) inFlight = undefined;
    });
    inFlight = request;
    return request;
  }

  return {
    current: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    refreshIfMounted() {
      if (mounted.size) void refresh();
    },
    attach(id: symbol) {
      mounted.add(id);
      if (!current.owner) publish({ owner: id });
      return () => {
        mounted.delete(id);
        if (current.owner === id) {
          const owner = mounted.values().next().value ?? null;
          publish({ owner, open: owner !== null && current.open });
        }
      };
    },
    setOpen(open: boolean) {
      if (!disposed) publish({ open });
    },
    invalidate() {
      generation += 1;
      inFlight = undefined;
      nextReadAt = 0;
      publish({ snapshot: emptySnapshot("loading"), open: false });
      if (mounted.size > 0) void refresh();
    },
    dispose() {
      disposed = true;
      listeners.clear();
      mounted.clear();
    },
  };
}
export type InsightSession = ReturnType<typeof createSession>;
