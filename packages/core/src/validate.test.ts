import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { PathValidationError, validateCollectionPath, validateTaskTitle } from "./validate.js";

describe("validateTaskTitle", () => {
  test("rejects empty string", () => {
    const result = validateTaskTitle("");
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("rejects whitespace-only string", () => {
    const result = validateTaskTitle("   ");
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("rejects title exceeding 200 characters", () => {
    const result = validateTaskTitle("a".repeat(201));
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("accepts title of exactly 200 characters", () => {
    const result = validateTaskTitle("a".repeat(200));
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("accepts a valid title", () => {
    const result = validateTaskTitle("Fix the authentication bug");
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("trims leading and trailing whitespace before validation", () => {
    const result = validateTaskTitle("  valid title  ");
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("title that is 201 chars after trimming is rejected", () => {
    const result = validateTaskTitle(`  ${"a".repeat(201)}  `);
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("padded title that trims to exactly 200 characters is accepted", () => {
    const result = validateTaskTitle(`  ${"a".repeat(200)}  `);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("error message for too-long title includes actual length", () => {
    const result = validateTaskTitle("a".repeat(201));
    expect(result.error).toContain("got 201");
  });
});

describe("validateCollectionPath", () => {
  test("rejects relative paths", () => {
    expect(() => validateCollectionPath("./docs")).toThrow(PathValidationError);
  });

  test("rejects empty path", () => {
    expect(() => validateCollectionPath("")).toThrow(PathValidationError);
  });

  test("rejects non-existent directory", () => {
    const missing = `${tmpdir()}/orc-does-not-exist-${Date.now()}`;
    expect(() => validateCollectionPath(missing)).toThrow(PathValidationError);
  });

  test("accepts an existing absolute directory and returns a resolved path", () => {
    const resolved = validateCollectionPath(tmpdir());
    expect(resolved.length).toBeGreaterThan(0);
  });
});
