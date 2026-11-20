import { z } from "zod";

export const CLAUDE_TOKENS_VERSION = 2;

/** Bumped when a transcript parser gains a new request field; forces one re-index. */
export const USAGE_EVENT_VERSION = 1;

/**
 * Raw request rows are kept for 95 days, just past the largest normal report window
 * (90 days). Older usage rolls up per session, UTC day and model so all-time totals
 * and distributions survive without unbounded per-request storage.
 */
export const USAGE_RAW_RETENTION_DAYS = 95;

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

const UsageTokenCount = z.number().finite().nonnegative();

/** Backends whose importers record per-request or per-session usage events. */
export const USAGE_SOURCE_BACKENDS = [
  "claude",
  "codex",
  "cursor",
  "gemini",
  "opencode",
  "pi",
] as const;

/** One request's consumption. `other_tokens` is unsplit usage some CLIs only expose as a total. */
export const UsageTokenTotalsSchema = z.object({
  input_tokens: UsageTokenCount,
  output_tokens: UsageTokenCount,
  cache_read_tokens: UsageTokenCount,
  cache_write_tokens: UsageTokenCount,
  reasoning_tokens: UsageTokenCount,
  other_tokens: UsageTokenCount,
  total_tokens: UsageTokenCount,
  requests: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  estimated_requests: z.number().int().nonnegative(),
});

export const UsageAgentBreakdownSchema = UsageTokenTotalsSchema.extend({
  agent: z.string(),
});

export const UsageModelBreakdownSchema = UsageTokenTotalsSchema.extend({
  agent: z.string(),
  model: z.string().nullable(),
});

export const UsageBucketSchema = UsageTokenTotalsSchema.extend({ bucket: z.string() });

export const UsageCoverageSchema = z.object({
  indexed_sessions: z.number().int().nonnegative(),
  unindexed_sessions: z.number().int().nonnegative(),
  unindexed_tokens: UsageTokenCount,
  unknown_sessions: z.number().int().nonnegative(),
  unsupported_sessions: z.number().int().nonnegative(),
  estimated_sessions: z.number().int().nonnegative(),
});

export const UsageReportSchema = z.object({
  days: z.number().int(),
  since: z.string().datetime().nullable(),
  granularity: z.enum(["day", "hour"]),
  filters: z.object({
    agent: z.string().nullable(),
    model: z.string().nullable(),
  }),
  totals: UsageTokenTotalsSchema,
  agents: z.array(UsageAgentBreakdownSchema),
  models: z.array(UsageModelBreakdownSchema),
  buckets: z.array(UsageBucketSchema),
  coverage: UsageCoverageSchema,
});

export type UsageHistory = z.infer<typeof UsageHistorySchema>;
export type UsageQuota = z.infer<typeof UsageQuotaSchema>;
export type UsageTokenTotals = z.infer<typeof UsageTokenTotalsSchema>;
export type UsageAgentBreakdown = z.infer<typeof UsageAgentBreakdownSchema>;
export type UsageModelBreakdown = z.infer<typeof UsageModelBreakdownSchema>;
export type UsageBucket = z.infer<typeof UsageBucketSchema>;
export type UsageCoverage = z.infer<typeof UsageCoverageSchema>;
export type UsageReport = z.infer<typeof UsageReportSchema>;

export const CacheTokenUsageSchema = z.object({
  input_tokens: z.number().nonnegative(),
  cached_input_tokens: z.number().nonnegative(),
  cache_write_tokens: z.number().nonnegative().nullable(),
});

export const SessionCacheUsageSchema = z.object({
  latest: CacheTokenUsageSchema.extend({
    recorded_at: z.string().datetime().nullable(),
    may_be_cold_after: z.string().datetime().nullable(),
    context_tokens: z.number().nonnegative().nullable().default(null),
    context_window: z.number().int().positive().nullable().default(null),
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
        /** Only set when the provider recorded why it compacted; never inferred. */
        trigger: z.enum(["manual", "auto"]).nullable().default(null),
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

/**
 * Best-effort token count from a backend's raw `result` usage, for run budgets.
 * Backends report different shapes (Claude input/output, Codex totalTokens,
 * nested totals); an unknown shape contributes 0, so a token budget is a floor
 * on recorded consumption, never a guess. The full per-request accounting lives
 * in the usage index, not here.
 */
export function resultUsageTokens(usage: unknown): number {
  if (typeof usage !== "object" || usage === null) return 0;
  const record = usage as Record<string, unknown>;
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const total = record.total;
  if (typeof total === "object" && total !== null) {
    const nested = total as Record<string, unknown>;
    const summed = num(nested.totalTokens) + num(nested.inputTokens) + num(nested.outputTokens);
    if (summed > 0) return summed;
  }
  const direct = num(record.totalTokens) || num(record.total_tokens);
  if (direct > 0) return direct;
  return (
    num(record.input_tokens) +
    num(record.output_tokens) +
    num(record.inputTokens) +
    num(record.outputTokens) +
    num(record.input) +
    num(record.output)
  );
}
