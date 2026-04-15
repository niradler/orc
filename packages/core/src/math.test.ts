import { describe, expect, test } from "bun:test";
import { clamp } from "./math.js";

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
