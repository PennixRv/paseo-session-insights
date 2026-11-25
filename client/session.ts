import { emptySnapshot, metricIds, type Snapshot } from "../shared/metrics.ts";

const refreshInterval = 15_000;
const settleDelay = 5_000;
const retryDelays = [2_000, 4_000, 8_000];

export function createSession(read: () => Promise<Snapshot>, clock = Date.now) {
  let current = emptySnapshot("loading");
  const listeners = new Set<() => void>();
  let readers = 0;
  let generation = 0;
  let nextReadAt = 0;
  let inFlight: Promise<void> | undefined;
  let disposed = false;
  let foreground = false;
  let connected = true;
  let failures = 0;
  let running = false;
  let settleAt: number | undefined;
  let continuing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status = { running, continuing, reading: false };

  function notify() {
    status = { running, continuing, reading: !!inFlight };
    for (const listener of listeners) listener();
  }

  const visible = () => !disposed && readers > 0 && foreground && connected;
  const retrying = () => failures > 0 && failures <= retryDelays.length;

  function schedule() {
    clearTimeout(timer);
    if (!visible() || inFlight || (!retrying() && !running && !continuing && settleAt === undefined)) return;
    const retryAt = continuing && !running ? current.metrics.cost.retryAt ?? 0 : 0;
    const due = Math.max(nextReadAt, retrying() ? 0 : settleAt ?? 0, retryAt);
    timer = setTimeout(() => {
      if (clock() < due) schedule();
      else void refresh(true);
    }, Math.min(2_147_483_647, Math.max(0, due - clock())));
  }

  function failed(snapshot: Snapshot, unlinked = false) {
    if (unlinked || metricIds.every(id => !("value" in current.metrics[id]))) current = snapshot;
    continuing = false;
    failures++;
    nextReadAt = clock() + (retryDelays[failures - 1] ?? refreshInterval);
  }

  function resume() {
    if (!visible()) return;
    failures = 0;
    if (!inFlight) {
      nextReadAt = 0;
      void refresh(true);
    }
  }

  function refresh(automatic = false): Promise<void> {
    if (inFlight) return inFlight;
    if (disposed || (automatic && (!visible() || clock() < nextReadAt))) return Promise.resolve();
    const expected = generation;
    clearTimeout(timer);
    const request = Promise.resolve().then(async () => {
      if (disposed || expected !== generation || (automatic && !visible())) return;
      const startedAt = clock();
      if (settleAt !== undefined && startedAt >= settleAt) settleAt = undefined;
      nextReadAt = startedAt + refreshInterval;
      const snapshot = await read();
      if (disposed || expected !== generation) return;
      const state = snapshot.metrics.input.state;
      if ((state === "error" || state === "unlinked" || state === "rate-limited") &&
          metricIds.every(id => snapshot.metrics[id].state === state && !("value" in snapshot.metrics[id]))) {
        failed(snapshot, state === "unlinked");
        return;
      }
      failures = 0;
      current = snapshot;
      const cost = snapshot.metrics.cost;
      if (!cost.hasMoreBilling || cost.state === "error") continuing = false;
    }).catch(() => {
      if (disposed || expected !== generation) return;
      failed(emptySnapshot("error"));
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
    continueBilling() {
      if (!visible() || !current.metrics.cost.hasMoreBilling) return;
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
      if (active) resume();
      else {
        settleAt = undefined;
        continuing = false;
      }
      schedule();
      notify();
    },
    setConnected(online: boolean) {
      if (connected === online) return;
      connected = online;
      if (online) resume();
      schedule();
    },
    attach() {
      readers++;
      if (visible()) {
        if (failures > 0 && readers === 1) resume();
        else void refresh(true);
      }
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
      failures = 0;
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
