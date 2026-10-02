import { describe, expect, test } from "bun:test";
import { inheritLoginShellPath, loginShellPath, mergePaths } from "./login-path.js";

describe("mergePaths", () => {
  test("login entries first, duplicates and empties dropped", () => {
    expect(mergePaths("/a:/b:/usr/bin", "/usr/bin::/c:/a")).toBe("/a:/b:/usr/bin:/c");
  });
});

describe.skipIf(process.platform === "win32")("login shell PATH", () => {
  test("reads a non-empty PATH from the login shell", () => {
    const login = loginShellPath();
    expect(login).toContain("/usr/bin");
  });

  test("a minimal launchd-style PATH gains the login shell entries", () => {
    const before = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      inheritLoginShellPath();
      const parts = (process.env.PATH ?? "").split(":");
      expect(parts).toContain("/usr/bin");
      expect(parts.length).toBeGreaterThan(2);
    } finally {
      process.env.PATH = before;
    }
  });
});
