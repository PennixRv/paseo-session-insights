import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const metricIds = [
  "input", "output", "cachedInput", "cache", "compactions", "cost", "ttft", "tps",
  "planning", "inProgress", "completed", "cancelled", "working", "idle", "error", "ended",
] as const;
export type MetricId = typeof metricIds[number];

export const labels: Record<MetricId, string> = {
  input: "累计输入（含缓存）", output: "累计输出", cachedInput: "累计缓存输入", cache: "缓存命中", compactions: "已完成压缩",
  cost: "已结算费用", ttft: "首 token 耗时", tps: "流式输出速率",
  planning: "规划", inProgress: "进行", completed: "完成", cancelled: "取消",
  working: "执行", idle: "空闲", error: "出错", ended: "结束",
};

export const detailGroups = [
  { title: "本会话", ids: ["input", "output", "cachedInput", "cache", "compactions", "cost"] },
  { title: "最近流式请求样本", ids: ["ttft", "tps"] },
  { title: "Trellis 项目进度", ids: ["planning", "inProgress", "completed", "cancelled"] },
  { title: "Teamwork 协作", ids: ["working", "idle", "error", "ended"] },
] as const satisfies readonly { title: string; ids: readonly MetricId[] }[];

const finite = z.number().finite().nonnegative();
const stamp = z.number().int().nonnegative();
export const moneySchema = z.object({
  currency: z.string().regex(/^(?:[A-Z]{3}|CRED)$/),
  amount: z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/),
});
const sources = z.enum(["codex", "cchp", "sub2api", "trellis", "teamwork", "fixture"]);
const unavailable = z.enum([
  "loading", "waiting", "no-records", "unsupported", "unlinked", "forbidden", "error", "rate-limited",
]);
const fields = {
  source: sources.optional(),
  observedAt: stamp.optional(),
  sampleAt: stamp.optional(),
  basis: z.string().max(80).optional(),
  hasMoreBilling: z.literal(true).optional(),
  retryAt: stamp.optional(),
};
const metric = z.union([
  z.object({ ...fields, state: z.enum(["ready", "partial", "stale"]), value: z.union([finite, z.array(moneySchema).min(1).max(16)]) }),
  z.object({ ...fields, state: unavailable }),
]);
export type Metric = z.infer<typeof metric>;
export type MetricSource = z.infer<typeof sources>;
export type Unavailable = z.infer<typeof unavailable>;

export const snapshotSchema = z.object({
  metrics: z.record(z.enum(metricIds), metric),
  fixture: z.boolean(),
}).superRefine(({ metrics }, ctx) => {
  for (const id of metricIds) {
    const reading = metrics[id];
    if ((reading.hasMoreBilling && id !== "cost") ||
        (reading.retryAt !== undefined && reading.state !== "rate-limited")) {
      ctx.addIssue({ code: "custom", path: ["metrics", id], message: "unexpected metric metadata" });
    }
    if (!("value" in reading)) continue;
    const value = reading.value;
    const correct = id === "cost" ? Array.isArray(value) : typeof value === "number" &&
      (id === "cache" ? value <= 100 :
        id === "ttft" || id === "tps" || Number.isSafeInteger(value));
    if (!correct) ctx.addIssue({ code: "custom", path: ["metrics", id, "value"], message: "unexpected metric value" });
  }
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const targetSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(128),
}).strict();
export type Target = z.infer<typeof targetSchema>;

export const insightsRpc = defineRpc({ name: "insights.snapshot", input: targetSchema, output: snapshotSchema });

export function emptySnapshot(state: Unavailable): Snapshot {
  return { metrics: Object.fromEntries(metricIds.map(id => [id, { state }])) as Snapshot["metrics"], fixture: false };
}
