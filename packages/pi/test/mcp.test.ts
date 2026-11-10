import { describe, expect, test } from "bun:test";
import { buildMcpRegistration, buildMcpUrl, redact } from "../src/mcp.js";

const base = {
  apiBase: "http://127.0.0.1:7700",
  mode: "meta" as const,
  transport: "stdio" as const,
  command: "orc",
  exposure: "direct" as const,
  timeoutMs: 5000,
};

describe("buildMcpUrl", () => {
  test("adds mode and project query parameters", () => {
    const url = new URL(buildMcpUrl({ apiBase: "http://127.0.0.1:7700/", mode: "full" }, "my app"));
    expect(url.pathname).toBe("/mcp");
    expect(url.searchParams.get("mode")).toBe("full");
    expect(url.searchParams.get("project")).toBe("my app");
  });

  test("omits an unset project", () => {
    const url = new URL(buildMcpUrl({ apiBase: "http://127.0.0.1:7700", mode: "meta" }));
    expect(url.searchParams.has("project")).toBe(false);
  });
});

describe("buildMcpRegistration", () => {
  test("builds a stdio registration scoped to the active project and session", () => {
    const registration = buildMcpRegistration(
      { ...base, secret: "s3cret" },
      "orc",
      "ses_123",
      "C:/work/app",
    );

    expect(registration).toMatchObject({
      command: "orc",
      args: ["mcp", "--mode", "meta"],
      env: {
        ORC_API_BASE: "http://127.0.0.1:7700",
        ORC_API_SECRET: "s3cret",
        ORC_ACTIVE_PROJECT: "orc",
        ORC_SESSION_ID: "ses_123",
      },
      cwd: "C:/work/app",
      exposure: "direct",
      enabled: true,
      timeout: 5,
    });
  });

  test("omits secrets and optional scope when unset", () => {
    const registration = buildMcpRegistration(base);
    expect(registration).toMatchObject({
      command: "orc",
      env: { ORC_API_BASE: "http://127.0.0.1:7700" },
    });
    if (!("env" in registration)) throw new Error("expected stdio registration");
    expect(registration.env.ORC_API_SECRET).toBeUndefined();
    expect(registration.env.ORC_ACTIVE_PROJECT).toBeUndefined();
    expect(registration.env.ORC_SESSION_ID).toBeUndefined();
    expect(registration.cwd).toBeUndefined();
  });

  test("builds an HTTP registration with a bearer header", () => {
    const registration = buildMcpRegistration(
      { ...base, transport: "http", secret: "s3cret", timeoutMs: 12_000 },
      "orc",
    );
    if (!("url" in registration)) throw new Error("expected HTTP registration");

    const url = new URL(registration.url);
    expect(url.pathname).toBe("/mcp");
    expect(url.searchParams.get("mode")).toBe("meta");
    expect(url.searchParams.get("project")).toBe("orc");
    expect(registration.headers).toEqual({ Authorization: "Bearer s3cret" });
    expect(registration.timeout).toBe(12);
  });

  test("rounds the timeout up to whole seconds", () => {
    const registration = buildMcpRegistration({ ...base, timeoutMs: 250 });
    expect(registration.timeout).toBe(1);
  });
});

test("redact removes every occurrence of the secret", () => {
  expect(redact("a s3cret b s3cret", "s3cret")).toBe("a [redacted] b [redacted]");
  expect(redact("nothing", undefined)).toBe("nothing");
});
