import { expect, test } from "bun:test";
import {
  estimateCacheSavings,
  estimateUsageCost,
  ModelPricingMapSchema,
  resolveModelPrice,
  SessionCacheUsageSchema,
} from "./usage";

function usage(compactions: unknown) {
  return {
    latest: null,
    totals: null,
    output_tokens: null,
    requests: null,
    timeline: null,
    compactions,
  };
}

const compaction = { recorded_at: null, pre_tokens: null, post_tokens: null };

test("should keep a compaction trigger unknown when the payload does not record one", () => {
  // Older cached payloads predate the field: they must parse, not fail.
  expect(SessionCacheUsageSchema.parse(usage([compaction])).compactions).toEqual([
    { ...compaction, trigger: null },
  ]);
  expect(
    SessionCacheUsageSchema.parse(usage([{ ...compaction, trigger: null }])).compactions?.[0]
      ?.trigger,
  ).toBeNull();
});

test("should accept only the two recorded compaction triggers", () => {
  for (const trigger of ["manual", "auto"] as const)
    expect(
      SessionCacheUsageSchema.parse(usage([{ ...compaction, trigger }])).compactions?.[0]?.trigger,
    ).toBe(trigger);
  for (const trigger of ["automatic", "size", ""])
    expect(SessionCacheUsageSchema.safeParse(usage([{ ...compaction, trigger }])).success).toBe(
      false,
    );
});

test("should resolve default and overridden model prices with boundary matching and null for unknown", () => {
  expect(resolveModelPrice("claude-sonnet-4-5")).toMatchObject({
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  });
  expect(resolveModelPrice("anthropic/claude-sonnet-4-5-20250929")).toEqual(
    resolveModelPrice("claude-sonnet-4-5"),
  );
  expect(resolveModelPrice("claude-sonnet-4-5-2025-09-29")).toEqual(
    resolveModelPrice("claude-sonnet-4-5"),
  );
  expect(resolveModelPrice("claude-opus-4-6[1m]")).toEqual(resolveModelPrice("claude-opus-4-6"));
  expect(resolveModelPrice("gpt-4o-latest")).toEqual(resolveModelPrice("gpt-4o"));
  expect(resolveModelPrice("gpt-5-preview")).toEqual(resolveModelPrice("gpt-5"));
  expect(resolveModelPrice("claude-sonnet-4-5@20250929")).toEqual(
    resolveModelPrice("claude-sonnet-4-5"),
  );
  expect(resolveModelPrice("claude-sonnet-4-5:thinking")).toEqual(
    resolveModelPrice("claude-sonnet-4-5"),
  );
  for (const distinctTier of [
    "gpt-50",
    "gpt-4o-mini",
    "o3-mini",
    "o3-pro",
    "gpt-4.1-nano",
    "gpt-5-nano",
    "claude-opus-4-7",
    "acme/unpriced-custom",
  ]) {
    expect(resolveModelPrice(distinctTier)).toBeNull();
  }
  expect(resolveModelPrice(null)).toBeNull();

  for (const reserved of ["constructor", "prototype"]) {
    const payload = JSON.parse(`{"${reserved}":{"inputPerMillion":1,"outputPerMillion":2}}`);
    expect(ModelPricingMapSchema.safeParse(payload).success).toBe(false);
  }
  const protoPayload = JSON.parse('{"__proto__":{"inputPerMillion":1,"outputPerMillion":2}}');
  const protoResult = ModelPricingMapSchema.safeParse(protoPayload);
  if (protoResult.success) {
    expect(Object.keys(protoResult.data)).toEqual([]);
    expect(Object.getPrototypeOf(protoResult.data)).toBe(Object.prototype);
  }

  const overrides = {
    "claude-sonnet-4-5": {
      inputPerMillion: 2,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: 2.5,
    },
    "acme/custom-v1": {
      inputPerMillion: 1,
      outputPerMillion: 4,
    },
  };
  expect(resolveModelPrice("claude-sonnet-4-5", overrides)?.inputPerMillion).toBe(2);
  expect(resolveModelPrice("acme/custom-v1", overrides)?.outputPerMillion).toBe(4);
  expect(resolveModelPrice("claude-opus-4-6", overrides, { includeDefaults: false })).toBeNull();
  expect(
    resolveModelPrice("claude-sonnet-4-5", overrides, { includeDefaults: false }),
  ).not.toBeNull();
});

test("should compute token cost and net cache savings in USD", () => {
  const price = resolveModelPrice("claude-sonnet-4-5");
  if (!price) throw new Error("expected price");
  const tokens = {
    input: 100_000,
    output: 20_000,
    cacheRead: 500_000,
    cacheWrite: 100_000,
    reasoning: 10_000,
  };
  expect(estimateUsageCost(tokens, price)).toBe(1.275);
  expect(estimateCacheSavings(tokens, price)).toBe(1.275);
  expect(
    estimateCacheSavings(
      { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 50_000, reasoning: 0 },
      price,
    ),
  ).toBe(0);
});
