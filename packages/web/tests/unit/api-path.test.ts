import { describe, expect, test } from "bun:test";
import { staysInApi } from "../../src/lib/api-path";

describe("pad bridge paths", () => {
  const here = "http://lab:7700/scratchpad/abc";

  test("should allow API paths under a relative or absolute base", () => {
    expect(staysInApi("/tasks?limit=100", "/api", here)).toBe(true);
    expect(staysInApi("/scratchpads/x", "http://127.0.0.1:7701", here)).toBe(true);
    expect(staysInApi("/a/../tasks", "/api", here)).toBe(true);
  });

  test("should refuse paths that leave the API", () => {
    for (const apiUrl of ["/api", "/", "http://127.0.0.1:7701"]) {
      expect(staysInApi("//evil.com/x", apiUrl, here)).toBe(false);
      expect(staysInApi("/\\evil.com/x", apiUrl, here)).toBe(false);
      expect(staysInApi("http://evil.com/x", apiUrl, here)).toBe(false);
      expect(staysInApi("tasks", apiUrl, here)).toBe(false);
    }
    expect(staysInApi("/../x", "/api", here)).toBe(false);
    expect(staysInApi("/%2e%2e/x", "/api", here)).toBe(false);
    // A "/" base would join "/tasks" into "//tasks", another host.
    expect(staysInApi("/tasks", "/", here)).toBe(false);
  });
});
