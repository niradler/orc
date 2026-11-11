import { describe, expect, test } from "bun:test";
import { buildMcpUrl, redact } from "../src/mcp.js";

describe("buildMcpUrl", () => {
  test("always requests meta mode and adds the project", () => {
    const url = new URL(buildMcpUrl("http://127.0.0.1:7700/", "my app"));
    expect(url.pathname).toBe("/mcp");
    expect(url.searchParams.get("mode")).toBe("meta");
    expect(url.searchParams.get("project")).toBe("my app");
  });

  test("omits an unset project", () => {
    const url = new URL(buildMcpUrl("http://127.0.0.1:7700"));
    expect(url.searchParams.has("project")).toBe(false);
  });
});

test("redact removes every occurrence of the secret", () => {
  expect(redact("a s3cret b s3cret", "s3cret")).toBe("a [redacted] b [redacted]");
  expect(redact("nothing", undefined)).toBe("nothing");
});
