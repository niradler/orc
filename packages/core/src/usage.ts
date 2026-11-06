import { z } from "zod";

const UsageCountSchema = z.object({
  sessions: z.number().int().nonnegative(),
  tokens: z.number().nonnegative(),
  unknown_sessions: z.number().int().nonnegative(),
  estimated_sessions: z.number().int().nonnegative(),
});

export const UsageHistorySchema = z.object({
  days: z.number().int(),
  since: z.string().datetime().nullable(),
  totals: UsageCountSchema,
  agents: z.array(UsageCountSchema.extend({ agent: z.string() })),
  daily: z.array(UsageCountSchema.extend({ date: z.string() })),
});

export const UsageQuotaSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  status: z.enum(["available", "unavailable", "signed_out"]),
  message: z.string().nullable(),
  checked_at: z.string().datetime(),
  windows: z.array(
    z.object({
      label: z.string(),
      used_percent: z.number().min(0).max(100),
      resets_at: z.string().datetime().nullable(),
    }),
  ),
});

export const UsageQuotasSchema = z.object({ accounts: z.array(UsageQuotaSchema) });
export type UsageHistory = z.infer<typeof UsageHistorySchema>;
export type UsageQuota = z.infer<typeof UsageQuotaSchema>;
