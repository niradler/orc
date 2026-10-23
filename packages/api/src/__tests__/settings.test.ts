import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath, resetConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { Hono } from "hono";
import { bearerAuth } from "../middleware/auth";
import { settingsRouter } from "../routes/settings";

const originalHome = process.env.HOME;
const originalProfile = process.env.USERPROFILE;
const privateHome = mkdtempSync(join(tmpdir(), "orc-settings-test-"));
const app = new Hono();
app.onError((error, c) =>
  c.json(
    { error: "Request failed" },
    error instanceof OrcError ? (error.statusCode as 400 | 401) : 500,
  ),
);
app.use("/api/*", bearerAuth("test-secret"));
app.route("/api", settingsRouter);
const headers = { Authorization: "Bearer test-secret", "Content-Type": "application/json" };

beforeAll(() => {
  process.env.HOME = privateHome;
  process.env.USERPROFILE = privateHome;
  expect(globalConfigPath()).toBe(join(privateHome, ".orc", "config.json"));
  mkdirSync(join(privateHome, ".orc"));
  writeFileSync(
    globalConfigPath(),
    JSON.stringify({ api: { secret: "private-server-secret" }, custom: { keep: true } }),
  );
  resetConfig();
});
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalProfile;
  resetConfig();
});

test("should require authentication for reading and writing preferences", async () => {
  for (const method of ["GET", "PATCH"]) {
    expect((await app.request("/api/settings", { method })).status).toBe(401);
  }
});

test("should persist selected settings without changing or exposing credentials", async () => {
  const saved = await app.request("/api/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ theme: "light", terminal_font: "Test Mono" }),
  });
  expect(saved.status).toBe(200);
  resetConfig();
  const result = await app.request("/api/settings", { headers });
  expect(await result.json()).toEqual({ theme: "light", terminal_font: "Test Mono" });
  const raw = JSON.parse(readFileSync(globalConfigPath(), "utf8"));
  expect(raw.api.secret).toBe("private-server-secret");
  expect(raw.custom).toEqual({ keep: true });
  expect(raw.preferences).toEqual({ theme: "light", terminal_font: "Test Mono" });
});

test("should reject unknown settings, credential writes and invalid values", async () => {
  for (const body of [{ secret: "bad" }, { theme: "pink" }, { terminal_font: "x".repeat(201) }]) {
    expect(
      (await app.request("/api/settings", { method: "PATCH", headers, body: JSON.stringify(body) }))
        .status,
    ).toBe(400);
  }
});

test("should patch one setting while preserving the other", async () => {
  const result = await app.request("/api/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ theme: "dark" }),
  });
  expect(await result.json()).toEqual({ theme: "dark", terminal_font: "Test Mono" });
});

test("should persist validated chat defaults without exposing server credentials", async () => {
  const chat = {
    agent: "claude",
    model: "fixture-model",
    system: "Test operator instructions",
    autoApprove: false,
    mcp: "orc",
    models: [{ agent: "claude", id: "fixture-model" }],
  };
  const saved = await app.request("/api/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ chat }),
  });
  expect(saved.status).toBe(200);
  resetConfig();
  const result = await app.request("/api/settings", { headers });
  const text = await result.text();
  expect(JSON.parse(text).chat).toEqual(chat);
  expect(text).not.toContain("private-server-secret");
  for (const patch of [
    { ...chat, api_key: "secret" },
    { ...chat, model: "--help" },
    { ...chat, models: [{ agent: "claude", id: "bad\nmodel" }] },
  ]) {
    expect(
      (
        await app.request("/api/settings", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ chat: patch }),
        })
      ).status,
    ).toBe(400);
  }
});
