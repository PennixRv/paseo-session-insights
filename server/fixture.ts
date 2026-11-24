import { metricIds, type Snapshot } from "../shared/metrics.ts";

const values = [25_900_000, 1_340_000, 22_533_000, 87, 12, [{ currency: "USD", amount: "4.28" }], 1200, 46, 3, 1, 12, 2, 1, 0, 1] as const;

export function fixtureSnapshot(observedAt: number): Snapshot {
  return {
    fixture: true,
    metrics: Object.fromEntries(metricIds.map((id, index) => [id, {
      state: "ready", value: values[index], source: "fixture", observedAt,
      ...(id === "ttft" || id === "tps" ? { sampleAt: observedAt, basis: "合成样例" } : {}),
    }])) as Snapshot["metrics"],
  };
}
