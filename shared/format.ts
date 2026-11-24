import type { Metric, MetricId } from "./metrics.ts";

export const stateLabels: Record<Metric["state"], string> = {
  loading: "正在读取", waiting: "等待记录", "no-records": "暂无记录", unsupported: "来源未接入",
  unlinked: "会话尚未关联", forbidden: "无法访问", error: "暂时读取失败", "rate-limited": "来源限流",
  ready: "", partial: "部分覆盖", stale: "已过期",
};

function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${Number((value / 1000).toFixed(1))}k`;
  return value.toExponential(0).replace("e+", "e");
}

export function formatMetric(id: MetricId, metric: Metric, summary = false): string {
  if (!("value" in metric)) return "—";
  const value = metric.value;
  if (Array.isArray(value)) {
    if (summary && value.length > 1) return "多币种";
    return value.map(({ amount, currency }) => {
      const shown = Number(amount) > 0 && Number(amount) < 0.01
        ? summary ? "<0.01" : amount
        : summary ? Number(amount).toFixed(2) : `${amount.split(".")[0]}.${(amount.split(".")[1] ?? "").padEnd(2, "0")}`;
      if (summary && shown.length > 7 && !shown.startsWith("<")) return `${Number(amount).toExponential(1)}${currency}`;
      return `${shown} ${currency}`;
    }).join(" · ");
  }
  if (id === "input" || id === "output" || id === "cachedInput") {
    const millions = value / 1e6;
    if (value > 0 && millions < 0.005) return summary ? "<.01M" : `${value.toLocaleString("en-US")} tokens`;
    if (!summary) return `${millions.toFixed(2)}M`;
    if (millions >= 10000) return compact(value);
    return `${Number(millions.toFixed(millions >= 10 ? millions >= 100 ? 0 : 1 : 2))}M`;
  }
  if (id === "cache") {
    if (value > 0 && value < 0.005) return "<0.01%";
    if (value < 100 && value >= 99.995) return ">99.99%";
    return `${summary ? Number(value.toFixed(2)) : value.toFixed(2)}%`;
  }
  if (id === "ttft") return value < 1 ? value === 0 ? "0ms" : "<1ms" : value < 1000 ? `${Math.round(value)}ms` : `${Number((value / 1000).toFixed(1))}s`;
  if (id === "tps") {
    const rate = value > 0 && value < 0.01 ? "<0.01" : String(Number(value.toPrecision(3)));
    return `${rate} tok/s`;
  }
  return summary ? compact(value) : String(value);
}
