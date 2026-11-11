import { expect, test } from "bun:test";
import { httpFallbackAllowed, typedWebUrl } from "./desktop-preview";

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

test("only connection failures fall back to http; certificate errors and aborts never do", () => {
  for (const code of [-102, -105, -107, -118, -101]) expect(httpFallbackAllowed(code)).toBe(true);
  for (const code of [-3, -200, -202, -207, -299]) expect(httpFallbackAllowed(code)).toBe(false);
});
