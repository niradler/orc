import { expect, test } from "bun:test";
import { sessionCacheIndicator } from "../../src/lib/session-cache";

test("cache indicator changes at the evidence-based time boundary without changing historical cache usage", () => {
  const latest = {
    input_tokens: 100,
    cached_input_tokens: 80,
    cache_write_tokens: 20,
    recorded_at: "2026-11-06T12:00:00Z",
    may_be_cold_after: "2026-11-06T12:05:00Z",
  };
  expect(sessionCacheIndicator(latest, Date.parse("2026-11-06T12:04:59Z"))).toEqual({
    label: "80% cached input",
    cold: false,
  });
  expect(sessionCacheIndicator(latest, Date.parse("2026-11-06T12:05:00Z"))).toEqual({
    label: "Cache may need rebuilding · 80% last reported",
    cold: true,
  });
  expect(
    sessionCacheIndicator(
      { ...latest, may_be_cold_after: null },
      Date.parse("2027-01-01T00:00:00Z"),
    ),
  ).toEqual({ label: "80% cached input", cold: false });
  expect(sessionCacheIndicator(null, Date.now())).toBeNull();
  expect(
    sessionCacheIndicator({ ...latest, input_tokens: 0, cached_input_tokens: 0 }, Date.now()),
  ).toBeNull();
});
