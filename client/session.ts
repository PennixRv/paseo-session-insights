import { emptySnapshot, type Snapshot } from "../shared/metrics.ts";

const refreshInterval = 15_000;
const settleDelay = 5_000;

export function createSession(read: () => Promise<Snapshot>, clock = Date.now) {
  let current = emptySnapshot("loading");
  const listeners = new Set<() => void>();
  let readers = 0;
  let generation = 0;
  let nextReadAt = 0;
  let inFlight: Promise<void> | undefined;
  let disposed = false;
  let foreground = false;
  let running = false;
  let settleAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function publish(snapshot: Snapshot) {
    current = snapshot;
    for (const listener of listeners) listener();
  }

  const visible = () => !disposed && readers > 0 && foreground;

  function schedule() {
    clearTimeout(timer);
    if (!visible() || inFlight || (!running && settleAt === undefined)) return;
    const due = Math.max(nextReadAt, settleAt ?? 0);
    timer = setTimeout(() => {
      settleAt = undefined;
      void refresh(true);
    }, Math.max(0, due - clock()));
  }

  function refresh(automatic = false): Promise<void> {
    if (inFlight) return inFlight;
    if (disposed || (automatic && !visible()) || clock() < nextReadAt) return Promise.resolve();
    const expected = generation;
    clearTimeout(timer);
    const request = Promise.resolve().then(async () => {
      if (disposed || expected !== generation || (automatic && !visible())) return;
      nextReadAt = clock() + refreshInterval;
      const snapshot = await read();
      if (!disposed && expected === generation) publish(snapshot);
    }).catch(() => {
      if (!disposed && expected === generation) publish(emptySnapshot("error"));
    }).finally(() => {
      if (inFlight === request) {
        inFlight = undefined;
        schedule();
      }
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
    refresh: () => refresh(),
    setRunning(active: boolean) {
      if (running === active) return;
      running = active;
      settleAt = !active && visible() ? clock() + settleDelay : undefined;
      if (active && visible()) void refresh(true);
      schedule();
    },
    setForeground(active: boolean) {
      if (foreground === active) return;
      foreground = active;
      if (visible()) void refresh(true);
      else settleAt = undefined;
      schedule();
    },
    attach() {
      readers++;
      if (visible()) void refresh(true);
      schedule();
      return () => {
        readers--;
        if (!readers) settleAt = undefined;
        schedule();
      };
    },
    invalidate() {
      generation += 1;
      inFlight = undefined;
      nextReadAt = 0;
      publish(emptySnapshot("loading"));
      if (visible()) void refresh(true);
      schedule();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      listeners.clear();
    },
  };
}
export type InsightSession = ReturnType<typeof createSession>;
