import { expect, test } from "bun:test";
import { SessionCacheUsageSchema } from "./usage";

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
