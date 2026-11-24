import { emptySnapshot, type Snapshot } from "../shared/metrics.ts";

export function createSession(read: () => Promise<Snapshot>, clock = Date.now) {
  let current = emptySnapshot("loading");
  const listeners = new Set<() => void>();
  let readers = 0;
  let generation = 0;
  let nextReadAt = 0;
  let inFlight: Promise<void> | undefined;
  let disposed = false;

  function publish(snapshot: Snapshot) {
    current = snapshot;
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
      if (!disposed && expected === generation) publish(snapshot);
    }).catch(() => {
      if (!disposed && expected === generation) publish(emptySnapshot("error"));
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
      if (readers) void refresh();
    },
    attach() {
      readers++;
      return () => { readers--; };
    },
    invalidate() {
      generation += 1;
      inFlight = undefined;
      nextReadAt = 0;
      publish(emptySnapshot("loading"));
      if (readers) void refresh();
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
export type InsightSession = ReturnType<typeof createSession>;
