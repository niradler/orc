import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChannelService, resetChannelService } from "@orc/channels";
import { ChannelConnectionSchema } from "@orc/core/channels";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { executeTool } from "@orc/mcp/tools";
import { createApp } from "../server.js";

const TOKEN = "12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const saved = Object.fromEntries(
  [
    "HOME",
    "USERPROFILE",
    "ORC_API_SECRET",
    "ORC_API_BASE",
    "ORC_DB_PATH",
    "ORC_ACTIVE_PROJECT",
    "ORC_TELEGRAM_TOKEN",
  ].map((key) => [key, process.env[key]]),
);
const home = mkdtempSync(join(tmpdir(), "orc-telegram-mcp-"));
const originalFetch = globalThis.fetch;
const calls: { url: string; body: string }[] = [];
let mode: "ok" | "leak" = "ok";
let app: ReturnType<typeof createApp>;
let server: ReturnType<typeof Bun.serve>;

function writeConfig(body: unknown) {
  mkdirSync(join(home, ".orc"), { recursive: true });
  writeFileSync(join(home, ".orc", "config.json"), JSON.stringify(body));
  resetConfig();
}

function clearChannels() {
  getSqlite().exec(
    "DELETE FROM channel_targets; DELETE FROM channel_routes; DELETE FROM channel_receipts; DELETE FROM channels;",
  );
}

function saveTelegram(input: {
  enabled?: boolean;
  targets: Array<{
    id: string;
    name: string;
    chat_id: string;
    project_ids?: string[];
    outbound?: boolean;
  }>;
}) {
  getChannelService().store.saveConnection(
    ChannelConnectionSchema.parse({
      id: "personal-telegram",
      name: "Personal Telegram",
      provider: "telegram",
      enabled: input.enabled ?? true,
      revision: 0,
      credentials: { token: "env:ORC_TELEGRAM_TOKEN" },
      targets: input.targets.map((target) => ({
        id: target.id,
        name: target.name,
        chat_id: target.chat_id,
        project_ids: target.project_ids ?? [],
        outbound: target.outbound ?? true,
        user_ids: [],
      })),
    }),
  );
}

async function api(method: string, path: string, body?: unknown) {
  const response = await app.request(path.startsWith("/api") ? path : `/api${path}`, {
    method,
    headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  return { status: response.status, raw, body: raw ? JSON.parse(raw) : null };
}

beforeAll(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_ACTIVE_PROJECT = "";
  delete process.env.ORC_TELEGRAM_TOKEN;
  writeConfig({});
  createTestDb();
  getSqlite().query("INSERT INTO projects (id, name) VALUES ('p1', 'orc')").run();
  getChannelService();
  app = createApp();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  process.env.ORC_API_BASE = String(server.url).replace(/\/$/, "");
  resetConfig();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://api.telegram.org/")) return originalFetch(input, init);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    if (mode === "leak")
      return Response.json({ ok: false, error_code: 400, description: `chat not found ${TOKEN}` });
    const payload = body ? (JSON.parse(body) as { chat_id?: string }) : {};
    return Response.json({
      ok: true,
      result: { message_id: 11, chat: { id: Number(payload.chat_id) } },
    });
  }) as typeof fetch;
});

beforeEach(() => {
  calls.length = 0;
  mode = "ok";
  delete process.env.ORC_TELEGRAM_TOKEN;
  clearChannels();
  writeConfig({});
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  server?.stop(true);
  resetChannelService();
  closeDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});

test("status and send explain missing Telegram setup and do not call Telegram", async () => {
  const status = await api("GET", "/telegram/status");
  expect(status.status).toBe(200);
  expect(status.body.ready).toBe(false);
  expect(status.body.token_configured).toBe(false);
  expect(status.body.setup).toContain("Settings");
  expect(status.body.setup).toContain("default_chat_id");
  const sent = await api("POST", "/telegram/send", { text: "Hello Nir" });
  expect(sent.status).toBe(400);
  expect(sent.body.code).toBe("VALIDATION_ERROR");
  expect(sent.raw).not.toContain(TOKEN);
  expect(calls).toHaveLength(0);
});

test("channel send uses the paired Nir recipient and hides the bot token", async () => {
  process.env.ORC_TELEGRAM_TOKEN = TOKEN;
  resetConfig();
  saveTelegram({
    targets: [
      { id: "me", name: "Nir", chat_id: "111", project_ids: ["p1"] },
      { id: "ops", name: "Ops", chat_id: "222" },
    ],
  });
  const status = await api("GET", "/telegram/status?project_id=p1");
  expect(status.body).toMatchObject({
    ready: true,
    via: "channel",
    token_configured: true,
    recipient: { name: "Nir", chat_id: "111", connection_id: "personal-telegram", target_id: "me" },
  });
  expect(status.raw).not.toContain(TOKEN);
  const missingProject = await api("POST", "/telegram/send", { text: "Hello Nir" });
  expect(missingProject.status).toBe(400);
  expect(missingProject.body.error).toContain("orc");
  expect(calls).toHaveLength(0);
  const sent = await api("POST", "/telegram/send", { text: "Hello Nir", project_id: "p1" });
  expect(sent.status).toBe(200);
  expect(sent.body).toMatchObject({
    via: "channel",
    status: "accepted",
    name: "Nir",
    chat_id: "111",
    target_id: "me",
  });
  expect(sent.raw).not.toContain(TOKEN);
  expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ chat_id: "111", text: "Hello Nir" });
  calls.length = 0;
  const other = await api("POST", "/telegram/send", { text: "Other", chat: "Ops" });
  expect(other.status).toBe(200);
  expect(JSON.parse(calls[0]?.body ?? "{}").chat_id).toBe("222");
  calls.length = 0;
  const unknown = await api("POST", "/telegram/send", { text: "Nope", chat: "someone-else" });
  expect(unknown.status).toBe(400);
  expect(unknown.body.error).toContain("someone-else");
  expect(calls).toHaveLength(0);
  const tool = JSON.parse(await executeTool("telegram_send", { text: "From MCP", project: "orc" }));
  expect(tool).toMatchObject({ via: "channel", name: "Nir", chat_id: "111" });
  expect(JSON.stringify(tool)).not.toContain(TOKEN);
  const listed = JSON.parse(await executeTool("telegram_status", { project: "orc" }));
  expect(listed.ready).toBe(true);
  expect(JSON.stringify(listed)).not.toContain(TOKEN);
});

test("ambiguous recipients and a disabled connection fail before Telegram is called", async () => {
  process.env.ORC_TELEGRAM_TOKEN = TOKEN;
  resetConfig();
  saveTelegram({
    targets: [
      { id: "ada", name: "Ada", chat_id: "1" },
      { id: "bea", name: "Bea", chat_id: "2" },
    ],
  });
  const ambiguous = await api("POST", "/telegram/send", { text: "Which one" });
  expect(ambiguous.status).toBe(400);
  expect(ambiguous.body.error).toContain("ada");
  expect(ambiguous.body.error).toContain("bea");
  expect(calls).toHaveLength(0);
  clearChannels();
  saveTelegram({ enabled: false, targets: [{ id: "me", name: "Nir", chat_id: "111" }] });
  delete process.env.ORC_TELEGRAM_TOKEN;
  resetConfig();
  const disabled = await api("GET", "/telegram/status");
  expect(disabled.body.ready).toBe(false);
  expect(disabled.body.setup).toContain("disabled");
  expect(disabled.raw).not.toContain(TOKEN);
});

test("gateway send uses bot sendMessage when no channel is enabled and redacts the token", async () => {
  writeConfig({
    gateway: {
      telegram: { enabled: true, token: TOKEN, default_chat_id: "9001" },
    },
  });
  const status = await api("GET", "/telegram/status");
  expect(status.body).toMatchObject({
    ready: true,
    via: "gateway",
    token_configured: true,
    recipient: { chat_id: "9001" },
  });
  expect(status.raw).not.toContain(TOKEN);
  const sent = await api("POST", "/telegram/send", { text: "Gateway hello" });
  expect(sent.status).toBe(200);
  expect(sent.body).toMatchObject({
    via: "gateway",
    status: "accepted",
    chat_id: "9001",
    message_id: 11,
  });
  expect(sent.raw).not.toContain(TOKEN);
  expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
    chat_id: "9001",
    text: "Gateway hello",
  });
  calls.length = 0;
  mode = "leak";
  const leaked = await api("POST", "/telegram/send", { text: "nope" });
  expect(leaked.status).toBe(502);
  expect(leaked.raw).not.toContain(TOKEN);
  expect(leaked.body.error).toContain("did not accept");
  writeConfig({
    gateway: { telegram: { enabled: true, token: TOKEN } },
  });
  calls.length = 0;
  mode = "ok";
  getSqlite()
    .query(
      "INSERT INTO bridge_chats (id, platform, chat_id, display_name, authorized, mode) VALUES ('telegram:77', 'telegram', '77', 'Nir', 1, 'direct')",
    )
    .run();
  const nir = await api("POST", "/telegram/send", { text: "Bridge" });
  expect(nir.status).toBe(200);
  expect(JSON.parse(calls[0]?.body ?? "{}").chat_id).toBe("77");
  calls.length = 0;
  const stranger = await api("POST", "/telegram/send", { text: "no", chat: "000" });
  expect(stranger.status).toBe(400);
  expect(calls).toHaveLength(0);
});
