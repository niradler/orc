import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("rejects a link that leads into a sensitive directory", () => {
    const home = mkdtempSync(join(tmpdir(), "orc-validate-"));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      mkdirSync(join(home, ".ssh"));
      const link = join(home, "innocent");
      // A junction needs no privileges on Windows; elsewhere it is a plain directory symlink.
      symlinkSync(join(home, ".ssh"), link, "junction");
      expect(() => validateCollectionPath(link)).toThrow(/sensitive/);
    } finally {
      process.env.HOME = saved.HOME;
      process.env.USERPROFILE = saved.USERPROFILE;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("accepts an existing absolute directory and returns a resolved path", () => {
    const resolved = validateCollectionPath(tmpdir());
    expect(resolved.length).toBeGreaterThan(0);
  });
});
