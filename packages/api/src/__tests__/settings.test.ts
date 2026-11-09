import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath, resetConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { ProviderSettingsSchema } from "@orc/core/providers";
import { closeDb, createTestDb } from "@orc/db/client";
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
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();
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
  closeDb();
  delete process.env.ORC_DB_PATH;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalProfile;
  resetConfig();
  rmSync(privateHome, { recursive: true, force: true });
});

test("should persist only validated provider executable paths without exposing credentials", async () => {
  const previous = readFileSync(globalConfigPath(), "utf8");
  const provider_paths = { codex: "C:\\Agent Tools\\codex.exe", claude: "~/bin/claude" };
  const saved = await app.request("/api/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ provider_paths }),
  });
  expect(saved.status).toBe(200);
  resetConfig();
  const read = await (await app.request("/api/settings", { headers })).json();
  expect(read).toMatchObject({ provider_paths });
  expect(JSON.stringify(read)).not.toContain("private-server-secret");
  for (const invalid of [
    { codex: "bad\0path" },
    { codex: "bad\npath" },
    { codex: "x".repeat(2049) },
    { api_key: "hidden" },
    { other: "tool" },
  ]) {
    const response = await app.request("/api/settings", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ provider_paths: invalid }),
    });
    expect(response.status).toBe(400);
  }
  writeFileSync(globalConfigPath(), previous);
  resetConfig();
});

test("should require authentication for reading and writing preferences", async () => {
  for (const method of ["GET", "PATCH"]) {
    expect((await app.request("/api/settings", { method })).status).toBe(401);
  }
  for (const method of ["GET", "PATCH"]) {
    expect((await app.request("/api/settings/mcp", { method })).status).toBe(401);
    expect((await app.request("/api/settings/security", { method })).status).toBe(401);
  }
});

test("should persist MCP defaults and serve DB prompts over HTTP and MCP", async () => {
  const settings = {
    default_mode: "full",
    prompts: [
      {
        name: "render-ui",
        title: "Live components",
        description: "Test prompt",
        content: "Use real entity ids for {{request}}\n\n{{ui_catalog}}",
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
  expect(raw.mcp.prompts).toBeUndefined();
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
  const tools = (await rpc("tools/list", {}, "?mode=full")).result.tools.map(
    (tool: { name: string }) => tool.name,
  );
  expect(tools).not.toContain("ui_catalog");
  expect(
    (await rpc("tools/list", {}, "?mode=meta")).result.tools.map(
      (tool: { name: string }) => tool.name,
    ),
  ).toEqual(["tool_search", "tool_describe", "tool_invoke"]);
  expect((await rpc("resources/list")).error).toBeDefined();
  expect((await rpc("prompts/list")).result.prompts).toEqual([
    {
      name: "render-ui",
      title: "Live components",
      description: "Test prompt",
      arguments: [
        { name: "request", description: "What you need, in your own words", required: false },
      ],
    },
  ]);
  const prompt = (
    await rpc("prompts/get", { name: "render-ui", arguments: { request: "the release board" } })
  ).result.messages[0].content.text;
  expect(prompt).toContain("Use real entity ids for the release board");
  expect(prompt).toContain("# ORC chat UI components");
  expect(prompt).toContain("## Examples");
  expect((await rpc("prompts/get", { name: "missing" })).error).toBeDefined();
  expect(
    (await rpc("prompts/get", { name: "render-ui", arguments: { unexpected: "x" } })).error,
  ).toBeDefined();
  for (const body of [
    { default_mode: "bad" },
    { ...settings, api_secret: "bad" },
    { ...settings, prompts: [...settings.prompts, ...settings.prompts] },
    { ...settings, prompts: [{ ...settings.prompts[0], name: "../bad" }] },
    { ...settings, prompts: [{ ...settings.prompts[0], include_ui_catalog: true }] },
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
    prompts: [{ ...settings.prompts[0], content: "Use real entity ids" }],
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
});

test("should read and write browser session security settings", async () => {
  expect(await (await app.request("/api/settings/security", { headers })).json()).toEqual({
    session_days: 30,
    cors_origins: [],
  });
  const body = { session_days: 7, cors_origins: ["https://ui.example.com/path"] };
  const saved = await app.request("/api/settings/security", {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
  expect(saved.status).toBe(200);
  resetConfig();
  expect(await (await app.request("/api/settings/security", { headers })).json()).toEqual({
    session_days: 7,
    cors_origins: ["https://ui.example.com"],
  });
  expect(JSON.parse(readFileSync(globalConfigPath(), "utf8")).api.secret).toBe(
    "private-server-secret",
  );
  for (const bad of [{ session_days: 0 }, { cors_origins: ["not a url"] }, { secret: "x" }]) {
    const res = await app.request("/api/settings/security", {
      method: "PATCH",
      headers,
      body: JSON.stringify(bad),
    });
    expect(res.status).toBe(400);
  }
  await app.request("/api/settings/security", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ session_days: 30, cors_origins: [] }),
  });
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

test("should save enabled coding agents and reject malformed agent ids", async () => {
  const saved = await app.request("/api/settings", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ agents: ["claude", "opencode", "my-acp-agent"] }),
  });
  expect(saved.status).toBe(200);
  resetConfig();
  const reloaded = await app.request("/api/settings", { headers });
  expect(((await reloaded.json()) as { agents?: string[] }).agents).toEqual([
    "claude",
    "opencode",
    "my-acp-agent",
  ]);
  for (const agents of [["Bad Id"], ["--help"], ["x".repeat(40)], "claude"]) {
    expect(
      (
        await app.request("/api/settings", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ agents }),
        })
      ).status,
    ).toBe(400);
  }
});

test("named provider API authenticates, masks secrets and preserves them on edit", async () => {
  const previous = readFileSync(globalConfigPath(), "utf8");
  try {
    for (const method of ["GET", "PUT"])
      expect((await app.request("/api/settings/providers", { method })).status).toBe(401);
    const initial = ProviderSettingsSchema.parse(
      await (await app.request("/api/settings/providers", { headers })).json(),
    );
    const profile = {
      id: "claude-gateway",
      name: "Claude gateway",
      agent: "claude",
      enabled: true,
      executable: "",
      model: "gateway-model",
      environment: [
        { name: "ANTHROPIC_AUTH_TOKEN", value: "private-fixture-token", secret: true },
        { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:4000", secret: false },
      ],
    };
    const put = async (value: unknown) =>
      app.request("/api/settings/providers", {
        method: "PUT",
        headers,
        body: JSON.stringify(value),
      });
    const response = await put({
      ...initial,
      default_provider_id: profile.id,
      providers: [...initial.providers, profile],
    });
    expect(response.status).toBe(200);
    const saved = ProviderSettingsSchema.parse(await response.json());
    expect(
      saved.providers.find((item) => item.id === profile.id)?.environment[0]?.value,
    ).toBeNull();
    expect(JSON.stringify(saved)).not.toContain("private-fixture-token");
    expect(readFileSync(globalConfigPath(), "utf8")).not.toContain("private-fixture-token");
    const prefs = (await (await app.request("/api/settings", { headers })).json()) as {
      chat: unknown;
    };
    expect(prefs.chat).toMatchObject({
      providerId: profile.id,
      agent: "claude",
      model: "gateway-model",
    });
    expect(JSON.stringify(prefs)).not.toMatch(/private-fixture-token|enc:v1:/);
    expect((await put(saved)).status).toBe(200);
    expect((await put(initial)).status).toBe(409);
    const invalid = await put({
      ...saved,
      providers: saved.providers.map((item: { id: string }) =>
        item.id === profile.id
          ? {
              ...item,
              environment: [
                { name: "ANTHROPIC_AUTH_TOKEN", value: "never-echo-input", secret: false },
              ],
            }
          : item,
      ),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("never-echo-input");
  } finally {
    writeFileSync(globalConfigPath(), previous);
    resetConfig();
  }
});
