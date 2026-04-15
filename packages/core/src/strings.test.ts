import { describe, expect, test } from "bun:test";
import { trimString } from "./strings.js";

describe("trimString", () => {
  test("trims leading and trailing whitespace", () => {
    expect(trimString("  hello  ")).toBe("hello");
  });

  test("truncates and appends ellipsis when trimmed string exceeds maxLen", () => {
    expect(trimString("  hello world  ", 5)).toBe("hello…");
  });

  test("does not truncate when trimmed string length equals maxLen", () => {
    expect(trimString("  hello  ", 5)).toBe("hello");
  });

  test("handles empty string", () => {
    expect(trimString("")).toBe("");
  });

  test("returns full trimmed string when maxLen is undefined", () => {
    expect(trimString("  hello world  ")).toBe("hello world");
  });
});
