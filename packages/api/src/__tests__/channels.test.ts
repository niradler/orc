import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelService } from "@orc/channels";
import type { ChannelTransport } from "@orc/channels/providers";
import { ChannelReceiptSchema, ChannelViewSchema } from "@orc/core/channels";
import { resetConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { ChannelStore } from "@orc/db/channels";
import { Hono } from "hono";
import { z } from "zod";
import { bearerAuth } from "../middleware/auth.js";
import { createChannelsRouter } from "../routes/channels.js";

const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const privateHome = mkdtempSync(join(tmpdir(), "orc-channel-api-"));
const db = new Database(":memory:");
db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('p1'),('p2')");
const sent: Record<string, unknown>[] = [];
const transport: ChannelTransport = {
  identity: async () => ({ id: "bot", name: "testbot" }),
  send: async (body) => {
    sent.push(body);
    return String(sent.length);
  },
  edit: async (_id, body) => {
    sent.push(body);
  },
  start: async () => {},
  stop: async () => {},
};
const store = new ChannelStore(db);
const service = new ChannelService(store, () => transport);
const app = new Hono();
app.onError((err, c) =>
  c.json(
    { error: err instanceof OrcError ? err.message : "Request failed" },
    err instanceof OrcError ? (err.statusCode as 400 | 403 | 404 | 409) : 500,
  ),
);
app.use("/api/*", bearerAuth("test-secret"));
app.route(
  "/api",
  createChannelsRouter(() => service),
);
const headers = { Authorization: "Bearer test-secret", "Content-Type": "application/json" };
const request = (path: string, method = "GET", body?: unknown) =>
  app.request(`/api${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
beforeAll(() => {
  process.env.HOME = privateHome;
  process.env.USERPROFILE = privateHome;
  resetConfig();
});
afterAll(async () => {
  await service.stop();
  db.close();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});

test("channel APIs require authentication, including setup and discovery", async () => {
  for (const [path, method] of [
    ["/channels", "GET"],
    ["/channels/providers", "GET"],
    ["/channels/slack-manifest", "GET"],
    ["/channels/test", "PUT"],
    ["/channels/messages", "POST"],
    ["/channels/pairings/test", "GET"],
  ] as const)
    expect((await app.request(`/api${path}`, { method })).status).toBe(401);
});

test("configuration persists in SQLite, hides secrets, preserves routing order and rejects stale writes", async () => {
  const input = {
    id: "test",
    name: "Personal Telegram",
    provider: "telegram",
    enabled: true,
    credentials: { token: "private-provider-token" },
    targets: [
      {
        id: "me",
        name: "Nir",
        chat_id: "123",
        user_ids: ["nir"],
        project_ids: ["p1"],
        inbound: true,
      },
    ],
    routes: [
      {
        id: "ignore",
        name: "Ignore noise",
        condition: { field: "text", op: "starts_with", value: "noise" },
        action: { type: "ignore" },
      },
      {
        id: "agent",
        name: "Agent",
        condition: { field: "is_direct", op: "is", value: true },
        action: { type: "agent", agent: "codex", project_id: "p1" },
      },
    ],
  };
  const response = await request("/channels/test", "PUT", input);
  expect(response.status).toBe(200);
  const saved = ChannelViewSchema.parse(await response.json());
  expect(saved.revision).toBe(1);
  expect(JSON.stringify(saved)).not.toContain("private-provider-token");
  expect(JSON.stringify(db.query("SELECT credentials FROM channels").get())).not.toContain(
    "private-provider-token",
  );
  expect(db.query("SELECT id FROM channel_routes ORDER BY position").all()).toEqual([
    { id: "ignore" },
    { id: "agent" },
  ]);
  expect(
    new ChannelService(new ChannelStore(db), () => transport)
      .list()
      .find((c) => c.id === "test")
      ?.routes.map((r) => r.id),
  ).toEqual(["ignore", "agent"]);
  expect((await request("/channels/test", "PUT", input)).status).toBe(409);
  expect((await request("/channels?project_id=p2")).status).toBe(200);
  expect(await (await request("/channels/test/targets?project_id=p2")).json()).toEqual([]);
});

test("route preview applies authorization, order and nested rules without invoking agents", async () => {
  let called = 0;
  service.handler = async () => {
    called++;
  };
  const probe = {
    sender: "nir",
    chat: "123",
    text: "noise hello",
    is_direct: true,
    is_mention: false,
  };
  expect(await (await request("/channels/test/route-test", "POST", probe)).json()).toMatchObject({
    authorized: true,
    route_id: "ignore",
    action: { type: "ignore" },
  });
  expect(
    await (
      await request("/channels/test/route-test", "POST", { ...probe, sender: "outsider" })
    ).json(),
  ).toMatchObject({ authorized: false, route_id: null });
  expect(called).toBe(0);
});

test("send/edit/status use common and native payloads through the HTTP interface", async () => {
  const input = {
    connection: "test",
    target: "me",
    project_id: "p1",
    message: { text: "**Done**" },
    overrides: {
      text: "<b>Native</b>",
      parse_mode: "HTML",
      provider_future_flag: { items: [1, { two: true }] },
    },
    idempotency_key: "api-send",
  };
  const response = await request("/channels/messages", "POST", input);
  expect(response.status).toBe(200);
  const receipt = ChannelReceiptSchema.parse(await response.json());
  expect(receipt.status).toBe("accepted");
  expect(sent[0]).toMatchObject({ ...input.overrides, chat_id: "123" });
  expect(
    ChannelReceiptSchema.parse(
      await (await request(`/channels/messages/${receipt.id}?project_id=p1`)).json(),
    ).id,
  ).toBe(receipt.id);
  expect((await request(`/channels/messages/${receipt.id}?project_id=p2`)).status).toBe(403);
  expect(
    (
      await request(`/channels/messages/${receipt.id}`, "PATCH", {
        message: { text: "Updated" },
        project_id: "p1",
      })
    ).status,
  ).toBe(200);
  expect(
    (await request("/channels/messages", "POST", { ...input, overrides: { chat_id: "other" } }))
      .status,
  ).toBe(400);
});

test("Telegram pairing requires the candidate, authenticated confirmation and unchanged connection", async () => {
  const pairing = z
    .object({ id: z.string(), url: z.string() })
    .parse(await (await request("/channels/test/pairings", "POST")).json());
  const token = new URL(pairing.url).searchParams.get("start")?.slice(4) ?? "";
  expect((await request(`/channels/pairings/${pairing.id}/confirm`, "POST")).status).toBe(409);
  store.offerPairing("test", token, { chat_id: "456", user_id: "nir", name: "Nir" });
  expect((await request(`/channels/pairings/${pairing.id}/confirm`, "POST")).status).toBe(200);
  expect((await request(`/channels/pairings/${pairing.id}/confirm`, "POST")).status).toBe(409);
  expect(service.connection("test").targets.find((t) => t.id === "me")?.chat_id).toBe("456");
});

test("invalid conditions and non-JSON native payloads are rejected", async () => {
  expect(
    (
      await request("/channels/messages", "POST", {
        connection: "test",
        target: "me",
        message: { text: "x" },
        overrides: { constructor: { prototype: {} } },
      })
    ).status,
  ).toBe(400);
  const current = service.connection("test");
  expect(
    (
      await request("/channels/test", "PUT", {
        ...current,
        credentials: {},
        routes: [{ id: "bad", name: "bad", action: { type: "ignore" }, condition: { any: [] } }],
      })
    ).status,
  ).toBe(400);
});
