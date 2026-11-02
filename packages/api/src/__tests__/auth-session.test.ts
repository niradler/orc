import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb } from "@orc/db/client";
import { z } from "zod";
import { createApp } from "../server.js";

const original = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CORS: process.env.ORC_API_CORS_ORIGINS,
};
const home = mkdtempSync(join(tmpdir(), "orc-auth-"));
let app: ReturnType<typeof createApp>;
const now = () => Math.floor(Date.now() / 1000);
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();
});

beforeEach(() => {
  delete process.env.ORC_API_CORS_ORIGINS;
  process.env.ORC_API_SECRET = "test-secret";
  resetConfig();
  app = createApp();
});

afterAll(() => {
  closeDb();
  delete process.env.ORC_API_SECRET;
  delete process.env.ORC_DB_PATH;
  restore("HOME", original.HOME);
  restore("USERPROFILE", original.USERPROFILE);
  restore("ORC_API_CORS_ORIGINS", original.CORS);
  resetConfig();
  rmSync(home, { recursive: true, force: true });
});

describe("browser sessions", () => {
  test("signing in sets an HttpOnly Strict cookie that authenticates the API", async () => {
    const res = await app.request("/api/auth/session", json({ secret: "test-secret" }));
    expect(res.status).toBe(200);
    const body = z
      .object({ required: z.boolean(), expires_at: z.number() })
      .parse(await res.json());
    expect(body.required).toBe(true);
    expect(Math.abs(body.expires_at - (now() + 30 * 86_400))).toBeLessThan(5);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).not.toContain("test-secret");
    const cookie = cookieOf(res);
    expect((await app.request("/api/projects", { headers: { Cookie: cookie } })).status).toBe(200);
    expect(
      await (await app.request("/api/auth/session", { headers: { Cookie: cookie } })).json(),
    ).toEqual({
      required: true,
      signed_in: true,
      expires_at: body.expires_at,
      default_expires_at: expect.any(Number),
    });
    expect(await (await app.request("/api/auth/session")).json()).toMatchObject({
      required: true,
      signed_in: false,
      expires_at: null,
    });
  });

  test("the consumer picks the expiry, within a year", async () => {
    const expiresAt = now() + 3 * 86_400;
    const res = await app.request(
      "/api/auth/session",
      json({ secret: "test-secret", expires_at: expiresAt }),
    );
    expect(z.object({ expires_at: z.number() }).parse(await res.json()).expires_at).toBe(expiresAt);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=(259200|25919\d);/);
    for (const bad of [now() - 10, now() + 400 * 86_400]) {
      const rejected = await app.request(
        "/api/auth/session",
        json({ secret: "test-secret", expires_at: bad }),
      );
      expect(rejected.status).toBe(400);
    }
  });

  test("a wrong secret, a forged cookie and a rotated secret are refused", async () => {
    expect((await app.request("/api/auth/session", json({ secret: "nope" }))).status).toBe(401);
    expect(
      (await app.request("/api/projects", { headers: { Cookie: "orc_session=forged" } })).status,
    ).toBe(401);
    const cookie = cookieOf(
      await app.request("/api/auth/session", json({ secret: "test-secret" })),
    );
    process.env.ORC_API_SECRET = "rotated-secret";
    resetConfig();
    const rotated = createApp();
    expect((await rotated.request("/api/projects", { headers: { Cookie: cookie } })).status).toBe(
      401,
    );
  });

  test("cookie writes need the UI header, which other origins cannot send without CORS", async () => {
    const cookie = cookieOf(
      await app.request("/api/auth/session", json({ secret: "test-secret" })),
    );
    const write = (headers: Record<string, string>) =>
      app.request("/api/tasks", json({ title: "x" }, { Cookie: cookie, ...headers }));
    expect((await write({ Origin: "http://localhost:5173" })).status).toBe(403);
    expect((await write({ "X-Orc-Source": "ui" })).status).not.toBe(403);
    expect((await app.request("/api/projects", { headers: { Cookie: cookie } })).status).toBe(200);
  });

  test("signing out clears the cookie", async () => {
    const res = await app.request("/api/auth/session", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain("orc_session=;");
  });

  test("cross-origin mode uses SameSite=None and checks the Origin on writes", async () => {
    process.env.ORC_API_CORS_ORIGINS = "https://ui.example.com";
    resetConfig();
    const cross = createApp();
    const res = await cross.request(
      "/api/auth/session",
      json({ secret: "test-secret" }, { Origin: "https://ui.example.com" }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://ui.example.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain("SameSite=None");
    expect(header).toContain("Secure");
    const cookie = cookieOf(res);
    const write = (origin: string) =>
      cross.request(
        "/api/tasks",
        json({ title: "x" }, { Cookie: cookie, Origin: origin, "X-Orc-Source": "ui" }),
      );
    expect((await write("https://evil.example.com")).status).toBe(403);
    expect((await write("https://ui.example.com")).status).not.toBe(403);
    const preflight = await cross.request("/api/projects", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "GET" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("API access tokens", () => {
  test("a token works as a Bearer credential until it expires", async () => {
    const expiresAt = now() + 3600;
    const res = await app.request(
      "/api/auth/token",
      json({ secret: "test-secret", expires_at: expiresAt }),
    );
    expect(res.status).toBe(200);
    const body = z.object({ token: z.string(), expires_at: z.number() }).parse(await res.json());
    expect(body.expires_at).toBe(expiresAt);
    expect(res.headers.get("set-cookie")).toBeNull();
    const auth = { Authorization: `Bearer ${body.token}` };
    expect((await app.request("/api/projects", { headers: auth })).status).toBe(200);
    expect(
      (await app.request("/api/projects", { headers: { Authorization: `Bearer ${body.token}x` } }))
        .status,
    ).toBe(401);
  });

  test("the raw secret still works as a Bearer credential", async () => {
    const res = await app.request("/api/projects", {
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(res.status).toBe(200);
  });

  test("a wrong secret gets no token", async () => {
    expect((await app.request("/api/auth/token", json({ secret: "nope" }))).status).toBe(401);
  });
});
