import { describe, expect, test } from "bun:test";
import { apiHostError, hostHeaders, normalizeApiUrl } from "../../src/lib/api-hosts";

const host = (headers: { name: string; value: string }[], token = "") => ({
  id: "host-1",
  label: "Work",
  url: "https://orc.example.com/api",
  token,
  headers,
});

describe("api hosts", () => {
  test("normalizes relative and absolute addresses for comparison", () => {
    expect(normalizeApiUrl("/api")).toBe("http://localhost/api");
    expect(normalizeApiUrl(" /api/ ")).toBe("http://localhost/api");
    expect(normalizeApiUrl("https://orc.example.com/api/")).toBe("https://orc.example.com/api");
    expect(normalizeApiUrl("")).toBe("http://localhost/api");
  });

  test("sends saved headers and replaces Authorization with the saved token", () => {
    expect(
      hostHeaders(
        host(
          [
            { name: "CF-Access-Client-Secret", value: "proxy" },
            { name: "Authorization", value: "Bearer stale" },
            { name: "X-Empty", value: "" },
          ],
          "fresh-jwt",
        ),
      ),
    ).toEqual({
      "CF-Access-Client-Secret": "proxy",
      Authorization: "Bearer fresh-jwt",
    });
  });

  test("leaves Authorization alone when no token is saved", () => {
    expect(hostHeaders(host([{ name: "Authorization", value: "Bearer saved" }]))).toEqual({
      Authorization: "Bearer saved",
    });
  });

  test("accepts relative paths and http(s) servers", () => {
    expect(apiHostError({ url: "/api", headers: [] })).toBeNull();
    expect(apiHostError({ url: "http://localhost:7701/api", headers: [] })).toBeNull();
    expect(apiHostError({ url: "https://orc.example.com/api", headers: [] })).toBeNull();
  });

  test("rejects missing, unsupported and malformed values", () => {
    expect(apiHostError({ url: "  ", headers: [] })).toContain("Enter the server URL");
    expect(apiHostError({ url: "ftp://orc.example.com", headers: [] })).toContain("http(s)");
    expect(apiHostError({ url: "/api", headers: [{ name: "Bad Header", value: "x" }] })).toContain(
      "not a valid header name",
    );
    expect(apiHostError({ url: "/api", headers: [{ name: "", value: "x" }] })).toContain("name");
    expect(apiHostError({ url: "/api", headers: [{ name: "X-Test", value: "a\nb" }] })).toContain(
      "line break",
    );
  });
});
