import { z } from "zod";

export const CLAUDE_TOKENS_VERSION = 1;

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
  provider: z.enum(["codex", "claude", "alibaba"]),
  provider_id: z.string().optional(),
  name: z.string().optional(),
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

export const CacheTokenUsageSchema = z.object({
  input_tokens: z.number().nonnegative(),
  cached_input_tokens: z.number().nonnegative(),
  cache_write_tokens: z.number().nonnegative().nullable(),
});

export const SessionCacheUsageSchema = z.object({
  latest: CacheTokenUsageSchema.extend({
    recorded_at: z.string().datetime().nullable(),
    may_be_cold_after: z.string().datetime().nullable(),
  }).nullable(),
  totals: CacheTokenUsageSchema.nullable(),
  output_tokens: z.number().nonnegative().nullable(),
  requests: z.number().int().nonnegative().nullable(),
  compactions: z
    .array(
      z.object({
        recorded_at: z.string().datetime().nullable(),
        pre_tokens: z.number().nonnegative().nullable(),
        post_tokens: z.number().nonnegative().nullable(),
      }),
    )
    .nullable(),
  timeline: z
    .array(
      z.object({
        request: z.number().int().positive(),
        recorded_at: z.string().datetime().nullable(),
        context_tokens: z.number().nonnegative(),
        cached_input_tokens: z.number().nonnegative(),
        output_tokens: z.number().nonnegative().nullable(),
      }),
    )
    .nullable(),
});

export type CacheTokenUsage = z.infer<typeof CacheTokenUsageSchema>;
export type SessionCacheUsage = z.infer<typeof SessionCacheUsageSchema>;
