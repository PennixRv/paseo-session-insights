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
  let continuing = false;
  let lastReadAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status = {
    mode: "paused" as "paused" | "automatic" | "settling" | "continuing",
    reading: false,
    lastReadAt,
  };

  function notify() {
    status = {
      mode: !visible() ? "paused" : continuing ? "continuing" :
        running ? "automatic" : settleAt === undefined ? "paused" : "settling",
      reading: !!inFlight,
      lastReadAt,
    };
    for (const listener of listeners) listener();
  }

  const visible = () => !disposed && readers > 0 && foreground;

  function schedule() {
    clearTimeout(timer);
    if (!visible() || inFlight || (!running && !continuing && settleAt === undefined)) return;
    const retryAt = continuing && !running ? current.metrics.cost.retryAt ?? 0 : 0;
    const due = Math.max(nextReadAt, settleAt ?? 0, retryAt);
    timer = setTimeout(() => {
      if (clock() < due) schedule();
      else void refresh(true);
    }, Math.min(2_147_483_647, Math.max(0, due - clock())));
  }

  function refresh(automatic = false): Promise<void> {
    if (inFlight) return inFlight;
    if (disposed || (automatic && !visible()) || clock() < nextReadAt) return Promise.resolve();
    const expected = generation;
    clearTimeout(timer);
    const request = Promise.resolve().then(async () => {
      if (disposed || expected !== generation || (automatic && !visible())) return;
      const startedAt = clock();
      if (settleAt !== undefined && startedAt >= settleAt) settleAt = undefined;
      nextReadAt = startedAt + refreshInterval;
      const snapshot = await read();
      if (disposed || expected !== generation) return;
      current = snapshot;
      const cost = snapshot.metrics.cost;
      if (cost.billing?.pages !== "more" || cost.state === "error") continuing = false;
      if (Object.values(snapshot.metrics).some(metric => metric.observedAt !== undefined)) lastReadAt = clock();
    }).catch(() => {
      if (disposed || expected !== generation) return;
      current = emptySnapshot("error");
      continuing = false;
    }).finally(() => {
      if (inFlight === request) {
        inFlight = undefined;
        schedule();
        notify();
      }
    });
    inFlight = request;
    notify();
    return request;
  }

  return {
    current: () => current,
    status: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh: () => refresh(),
    refreshFromDetails() {
      if (!visible() || inFlight) return 0;
      const waitMs = nextReadAt - clock();
      if (waitMs > 0) return waitMs;
      void refresh();
      return 0;
    },
    continueBilling() {
      if (!visible() || current.metrics.cost.billing?.pages !== "more") return;
      continuing = true;
      schedule();
      notify();
    },
    stopBilling() {
      if (!continuing) return;
      continuing = false;
      schedule();
      notify();
    },
    setRunning(active: boolean) {
      if (running === active) return;
      running = active;
      settleAt = !active && visible() ? clock() + settleDelay : undefined;
      if (active && visible()) void refresh(true);
      schedule();
      notify();
    },
    setForeground(active: boolean) {
      if (foreground === active) return;
      foreground = active;
      if (visible()) void refresh(true);
      else {
        settleAt = undefined;
        continuing = false;
      }
      schedule();
      notify();
    },
    attach() {
      readers++;
      if (visible()) void refresh(true);
      schedule();
      notify();
      return () => {
        readers--;
        if (!readers) {
          settleAt = undefined;
          continuing = false;
        }
        schedule();
        notify();
      };
    },
    invalidate() {
      generation += 1;
      inFlight = undefined;
      nextReadAt = 0;
      lastReadAt = undefined;
      continuing = false;
      current = emptySnapshot("loading");
      if (visible()) void refresh(true);
      schedule();
      notify();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      listeners.clear();
    },
  };
}
export type InsightSession = ReturnType<typeof createSession>;
