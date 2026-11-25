import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const count = z.int().nonnegative();
const amount = z.number().nonnegative().finite();
const percent = amount.max(100);
const date = z.iso.date();
const timestamp = z.iso.datetime({ offset: true });
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
    z.object({ state: z.enum(["disabled", "available", "missing-key", "error", "forbidden"]) }),
    z.object({
      state: z.literal("enabled"),
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
