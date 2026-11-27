import { describe, expect, test } from "bun:test";
import { DEFAULT_TTL_DAYS, MAX_TTL_DAYS, TtlDaysSchema, ttlDaysLeft, ttlDeadline } from "../ttl.js";

describe("ttl", () => {
  test("defaults missing, null and empty ttl_days instead of purging immediately", () => {
    expect(TtlDaysSchema.parse(undefined)).toBe(DEFAULT_TTL_DAYS);
    expect(TtlDaysSchema.parse(null)).toBe(DEFAULT_TTL_DAYS);
    expect(TtlDaysSchema.parse("")).toBe(DEFAULT_TTL_DAYS);
    expect(TtlDaysSchema.parse(0)).toBe(0);
    expect(TtlDaysSchema.parse("7")).toBe(7);
    expect(TtlDaysSchema.parse(MAX_TTL_DAYS)).toBe(MAX_TTL_DAYS);
    expect(() => TtlDaysSchema.parse(-1)).toThrow();
    expect(() => TtlDaysSchema.parse(MAX_TTL_DAYS + 1)).toThrow();
    expect(() => TtlDaysSchema.parse("soon")).toThrow();
  });

  test("computes the deadline and whole days left", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const deadline = ttlDeadline(7, now);
    expect(deadline.toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(ttlDaysLeft(deadline, now)).toBe(7);
    expect(ttlDaysLeft(Math.floor(deadline.getTime() / 1000), now)).toBe(7);
    expect(ttlDaysLeft(new Date("2025-12-31T00:00:00Z"), now)).toBe(0);
  });
});
