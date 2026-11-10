import { expect, test } from "bun:test";
import { typedWebUrl } from "./desktop-preview";

test("typed addresses default to https with an http fallback and keep explicit schemes", () => {
  expect(typedWebUrl("example.com")).toEqual({
    url: "https://example.com/",
    fallback: "http://example.com/",
  });
  expect(typedWebUrl("  localhost:3000/app ")).toEqual({
    url: "https://localhost:3000/app",
    fallback: "http://localhost:3000/app",
  });
  expect(typedWebUrl("http://example.com")).toEqual({ url: "http://example.com/", fallback: null });
  expect(typedWebUrl("https://a.test/x")).toEqual({ url: "https://a.test/x", fallback: null });
  expect(typedWebUrl("ftp://example.com")).toBeNull();
  expect(typedWebUrl("javascript:alert(1)")).toBeNull();
  expect(typedWebUrl("user:pass@example.com")).toBeNull();
});
