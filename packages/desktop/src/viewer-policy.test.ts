import { describe, expect, test } from "bun:test";
import { browserUrl, decodeText, MAX_TEXT_BYTES } from "./viewer-policy.js";

describe("desktop viewer boundary", () => {
  test("should allow web URLs and reject privileged schemes and embedded credentials", () => {
    expect(browserUrl("https://example.com/path?q=one#two")).toBe(
      "https://example.com/path?q=one#two",
    );
    expect(browserUrl("http://127.0.0.1:3077")).toBe("http://127.0.0.1:3077/");
    for (const value of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "https://user:password@example.com",
      "https://example.com/\nhi",
      "https://example.com/ hi",
      "not a URL",
      null,
      {},
      "x".repeat(8193),
    ])
      expect(browserUrl(value)).toBeNull();
  });
  test("should decode source literally without interpreting Markdown or HTML", () => {
    const text = "# Hello\n<script>alert('x')</script>\nconst x = `שלום`;\n";
    expect(decodeText(new TextEncoder().encode(text))).toBe(text);
    expect(decodeText(new Uint8Array())).toBe("");
  });
  test("should reject binary, invalid UTF-8 and oversized content", () => {
    for (const bytes of [
      new Uint8Array([65, 0, 66]),
      new Uint8Array([1, 2]),
      new Uint8Array([0xff, 0xfe]),
      new Uint8Array(MAX_TEXT_BYTES + 1),
    ])
      expect(() => decodeText(bytes)).toThrow();
    expect(decodeText(new Uint8Array(MAX_TEXT_BYTES).fill(65))).toHaveLength(MAX_TEXT_BYTES);
  });
});
