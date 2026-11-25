import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const count = z.int().nonnegative();
const amount = z.number().nonnegative().finite();
const percent = amount.max(100);
const binding = z.string().regex(/^[a-f0-9]{64}$/).optional();
const date = z.iso.date();
const timestamp = z.iso.datetime({ offset: true });
export const accountPlan = z.enum(["Free", "Go", "Plus", "Pro 100", "Pro 200", "Pro 500",
  "Business", "Business Premium", "Enterprise", "Enterprise (Automation)", "Edu", "Edu Plus", "Edu Pro"]);
const slot = <T extends z.ZodType>(data: T) => z.object({
  state: z.enum(["ready", "stale", "error", "rate-limited"]),
  data: data.optional(),
});
const stats = z.object({
  tokens: count, cost: amount, requests: count, cache: percent.nullable(),
});
export const accountRpc = defineRpc({
  name: "insights.account",
  input: z.strictObject({ statusOnly: z.literal(true).optional() }),
  output: z.discriminatedUnion("state", [
    z.object({ state: z.enum(["disabled", "missing-key", "error"]) }),
    z.object({ state: z.enum(["available", "forbidden"]), binding }),
    z.object({
      state: z.literal("enabled"),
      binding,
      plan: accountPlan.optional(),
      quota: slot(z.object({
        window: z.object({ used: percent, resetAt: count }).nullable(),
        cards: z.object({ count, earliest: z.union([date, timestamp]).nullable(), incomplete: z.boolean() }).nullable(),
      })),
      subscription: slot(z.union([date, timestamp]).nullable()),
      today: slot(stats),
      week: slot(stats),
    }),
  ]),
});
export type AccountSnapshot = z.output<typeof accountRpc.output>;

export function accountTitle(reading: AccountSnapshot | undefined): string {
  return reading?.state === "enabled" && reading.plan ? `ChatGPT ${reading.plan}` : "ChatGPT Status";
}
