import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath, resetConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { Hono } from "hono";
import { bearerAuth } from "../middleware/auth";
import { mcpRouter } from "../routes/mcp";
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
app.route("/", mcpRouter);
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
  for (const method of ["GET", "PATCH"]) {
    expect((await app.request("/api/settings/mcp", { method })).status).toBe(401);
  }
});

test("should persist MCP defaults and serve prompts and explicit mode overrides over HTTP", async () => {
  const settings = {
    default_mode: "full",
    prompts: [
      {
        name: "render-ui",
        title: "Live components",
        description: "Test prompt",
        content: "Use real entity ids",
        include_ui_catalog: true,
      },
    ],
  };
  const saved = await app.request("/api/settings/mcp", {
    method: "PATCH",
    headers,
    body: JSON.stringify(settings),
  });
  expect(saved.status).toBe(200);
  resetConfig();
  expect(await (await app.request("/api/settings/mcp", { headers })).json()).toEqual(settings);
  const raw = JSON.parse(readFileSync(globalConfigPath(), "utf8"));
  expect(raw.api.secret).toBe("private-server-secret");
  expect(raw.mcp.default_mode).toBe("full");
  async function rpc(method: string, params = {}, query = "") {
    const response = await app.request(`/mcp${query}`, {
      method: "POST",
      headers: {
        ...headers,
        Authorization: "Bearer private-server-secret",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  }
  expect(
    (await rpc("tools/list")).result.tools.map((tool: { name: string }) => tool.name),
  ).toContain("ui_catalog");
  expect(
    (await rpc("tools/list", {}, "?mode=meta")).result.tools.map(
      (tool: { name: string }) => tool.name,
    ),
  ).toEqual(["tool_search", "tool_describe", "tool_invoke"]);
  expect((await rpc("prompts/list")).result.prompts).toEqual([
    { name: "render-ui", title: "Live components", description: "Test prompt" },
  ]);
  const prompt = (await rpc("prompts/get", { name: "render-ui" })).result.messages[0].content.text;
  expect(prompt).toContain("Use real entity ids");
  expect(prompt).toContain("# ORC chat UI components");
  expect((await rpc("prompts/get", { name: "missing" })).error).toBeDefined();
  expect(
    (await rpc("prompts/get", { name: "render-ui", arguments: { unexpected: "x" } })).error,
  ).toBeDefined();
  for (const body of [
    { default_mode: "bad" },
    { ...settings, api_secret: "bad" },
    { ...settings, prompts: [...settings.prompts, ...settings.prompts] },
    { ...settings, prompts: [{ ...settings.prompts[0], name: "../bad" }] },
  ]) {
    expect(
      (
        await app.request("/api/settings/mcp", {
          method: "PATCH",
          headers,
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(400);
  }
  const plain = {
    default_mode: "meta",
    prompts: [{ ...settings.prompts[0], include_ui_catalog: false }],
  };
  expect(
    (
      await app.request("/api/settings/mcp", {
        method: "PATCH",
        headers,
        body: JSON.stringify(plain),
      })
    ).status,
  ).toBe(200);
  expect((await rpc("prompts/get", { name: "render-ui" })).result.messages[0].content.text).toBe(
    "Use real entity ids",
  );
  expect(
    (await rpc("tools/list", {}, "?mode=full")).result.tools.map(
      (tool: { name: string }) => tool.name,
    ),
  ).toContain("ui_catalog");
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
  for (const body of [
    { secret: "bad" },
    { theme: "pink" },
    { terminal_font: "x".repeat(201) },
    ...[0, -1, 1.5, 8761, "72"].map((value) => ({ attention_retention_hours: value })),
  ]) {
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
  expect(JSON.parse(text).chat).toEqual({ ...chat, agentOptions: {} });
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

test("should save and reload attention retention without exposing credentials", async () => {
  const result = await app.request("/api/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ attention_retention_hours: 48 }),
  });
  expect(result.status).toBe(200);
  resetConfig();
  const reloaded = await app.request("/api/settings", { headers });
  const body = await reloaded.text();
  expect(JSON.parse(body).attention_retention_hours).toBe(48);
  expect(body).not.toContain("private-server-secret");
});
