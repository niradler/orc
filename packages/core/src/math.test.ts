import { describe, expect, test } from "bun:test";
import { clamp, roundTo } from "./math.js";

describe("clamp", () => {
  test("returns min when value is below min", () => {
    expect(clamp(1, 5, 10)).toBe(5);
  });

  test("returns max when value is above max", () => {
    expect(clamp(15, 5, 10)).toBe(10);
  });

  test("returns value when value is in range", () => {
    expect(clamp(7, 5, 10)).toBe(7);
  });

  test("returns min when value equals min", () => {
    expect(clamp(5, 5, 10)).toBe(5);
  });

  test("returns max when value equals max", () => {
    expect(clamp(10, 5, 10)).toBe(10);
  });

  test("throws when min > max", () => {
    expect(() => clamp(5, 10, 5)).toThrow("clamp: min must be <= max");
  });
});

describe("roundTo", () => {
  test("returns integer 4 when rounding 3.7 to 0 decimal places", () => {
    const result = roundTo(3.7, 0);
    expect(result).toBe(4);
    expect(Number.isInteger(result)).toBe(true);
  });

  test("rounds to 2 decimal places", () => {
    expect(roundTo(Math.PI, 2)).toBe(3.14);
  });

  test("rounds up at midpoint", () => {
    expect(roundTo(2.5, 0)).toBe(3);
  });

  test("returns integer unchanged when decimals is 0 and value is whole", () => {
    expect(roundTo(5, 0)).toBe(5);
  });

  test("handles negative values", () => {
    expect(roundTo(-2.567, 2)).toBe(-2.57);
  });

  test("handles zero", () => {
    expect(roundTo(0, 3)).toBe(0);
  });

  test("throws when decimals is negative", () => {
    expect(() => roundTo(3.14, -1)).toThrow("roundTo: decimals must be >= 0");
  });
});
