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

export const ModelPriceSchema = z
  .object({
    inputPerMillion: z.number().finite().nonnegative(),
    outputPerMillion: z.number().finite().nonnegative(),
    cacheReadPerMillion: z.number().finite().nonnegative().optional(),
    cacheWritePerMillion: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

const FORBIDDEN_PRICING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const ModelPricingKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (key) => !FORBIDDEN_PRICING_KEYS.has(key.toLowerCase()),
    "Reserved model names are not allowed",
  );

export const ModelPricingMapSchema = z
  .record(ModelPricingKeySchema, ModelPriceSchema)
  .refine((value) => Object.keys(value).length <= 200, "At most 200 model price overrides");
export type ModelPricingMap = z.infer<typeof ModelPricingMapSchema>;

export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-4-6": {
    inputPerMillion: 5,
    outputPerMillion: 25,
    cacheReadPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
  },
  "claude-opus-4-5": {
    inputPerMillion: 5,
    outputPerMillion: 25,
    cacheReadPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
  },
  "claude-opus-4-1": {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
  },
  "claude-opus-4": {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
  },
  "claude-sonnet-4-6": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  "claude-sonnet-4-5": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  "claude-sonnet-4": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  "claude-3-7-sonnet": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  "claude-3-5-sonnet": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  "claude-haiku-4-5": {
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
  },
  "claude-3-5-haiku": {
    inputPerMillion: 0.8,
    outputPerMillion: 4,
    cacheReadPerMillion: 0.08,
    cacheWritePerMillion: 1,
  },
  "gpt-5.4": {
    inputPerMillion: 2.5,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.25,
  },
  "gpt-5.3-codex": {
    inputPerMillion: 1.75,
    outputPerMillion: 14,
    cacheReadPerMillion: 0.175,
  },
  "gpt-5.2-codex": {
    inputPerMillion: 1.75,
    outputPerMillion: 14,
    cacheReadPerMillion: 0.175,
  },
  "gpt-5.2": {
    inputPerMillion: 1.75,
    outputPerMillion: 14,
    cacheReadPerMillion: 0.175,
  },
  "gpt-5.1-codex-mini": {
    inputPerMillion: 0.25,
    outputPerMillion: 2,
    cacheReadPerMillion: 0.025,
  },
  "gpt-5.1-codex": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.125,
  },
  "gpt-5.1": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.125,
  },
  "gpt-5-codex": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.125,
  },
  "gpt-5-mini": {
    inputPerMillion: 0.25,
    outputPerMillion: 2,
    cacheReadPerMillion: 0.025,
  },
  "gpt-5": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.125,
  },
  "gpt-4.1-mini": {
    inputPerMillion: 0.4,
    outputPerMillion: 1.6,
    cacheReadPerMillion: 0.1,
  },
  "gpt-4.1": {
    inputPerMillion: 2,
    outputPerMillion: 8,
    cacheReadPerMillion: 0.5,
  },
  "gpt-4o": {
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    cacheReadPerMillion: 1.25,
  },
  o3: {
    inputPerMillion: 2,
    outputPerMillion: 8,
    cacheReadPerMillion: 0.5,
  },
  "o4-mini": {
    inputPerMillion: 1.1,
    outputPerMillion: 4.4,
    cacheReadPerMillion: 0.275,
  },
  "gemini-2.5-pro": {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.31,
  },
  "gemini-2.5-flash": {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cacheReadPerMillion: 0.0375,
  },
};

function stripModelProvider(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

const ALLOWED_MODEL_SUFFIX =
  /^(?:-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest|preview)|@[^\s]+|:[^\s]+|\[[^\]]+\])+$/;

function lookupPriceTable(
  normalized: string,
  stripped: string,
  table: Readonly<Record<string, ModelPrice>>,
): ModelPrice | null {
  const entries = Object.entries(table).map(
    ([key, price]) => [key.trim().toLowerCase(), price] as const,
  );
  for (const [key, price] of entries) {
    if (key === normalized) return price;
  }
  for (const [key, price] of entries) {
    if (stripModelProvider(key) === stripped) return price;
  }
  let bestKey = "";
  let bestPrice: ModelPrice | null = null;
  for (const [key, price] of entries) {
    const candidate = stripModelProvider(key);
    if (
      stripped.startsWith(candidate) &&
      ALLOWED_MODEL_SUFFIX.test(stripped.slice(candidate.length)) &&
      candidate.length > bestKey.length
    ) {
      bestKey = candidate;
      bestPrice = price;
    }
  }
  return bestPrice;
}

export function resolveModelPrice(
  model: string | null | undefined,
  overrides?: Readonly<Record<string, ModelPrice>> | null,
  options?: { includeDefaults?: boolean },
): ModelPrice | null {
  const raw = model?.trim().toLowerCase();
  if (!raw) return null;
  const stripped = stripModelProvider(raw);
  if (overrides) {
    const custom = lookupPriceTable(raw, stripped, overrides);
    if (custom) return custom;
  }
  if (options?.includeDefaults === false) return null;
  return lookupPriceTable(raw, stripped, DEFAULT_MODEL_PRICING);
}

export type TokenCostInput = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
};

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function estimateUsageCost(tokens: TokenCostInput, price: ModelPrice): number {
  const cacheReadRate = price.cacheReadPerMillion ?? price.inputPerMillion;
  const cacheWriteRate = price.cacheWritePerMillion ?? price.inputPerMillion;
  const usd =
    (tokens.input * price.inputPerMillion +
      (tokens.output + tokens.reasoning) * price.outputPerMillion +
      tokens.cacheRead * cacheReadRate +
      tokens.cacheWrite * cacheWriteRate) /
    1_000_000;
  return roundUsd(Math.max(0, usd));
}

export function netCacheSavingsUsd(tokens: TokenCostInput, price: ModelPrice): number {
  const cacheReadRate = price.cacheReadPerMillion ?? price.inputPerMillion;
  const cacheWriteRate = price.cacheWritePerMillion ?? price.inputPerMillion;
  return (
    (tokens.cacheRead * (price.inputPerMillion - cacheReadRate) -
      tokens.cacheWrite * (cacheWriteRate - price.inputPerMillion)) /
    1_000_000
  );
}

export function estimateCacheSavings(tokens: TokenCostInput, price: ModelPrice): number {
  return roundUsd(Math.max(0, netCacheSavingsUsd(tokens, price)));
}

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
