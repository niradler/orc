import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelsRouter } from "@orc/api/channels-router";
import { ChannelService } from "@orc/channels";
import type { ChannelTransport } from "@orc/channels/providers";
import { resetConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { ChannelStore } from "@orc/db/channels";
import { createTestDb, getSqlite } from "@orc/db/client";
import { executeTool } from "../tools.js";

const saved = Object.fromEntries(
  ["HOME", "USERPROFILE", "ORC_API_BASE", "ORC_DB_PATH", "ORC_ACTIVE_PROJECT"].map((k) => [
    k,
    process.env[k],
  ]),
);
let service: ChannelService;
let server: ReturnType<typeof Bun.serve>;
const sent: Record<string, unknown>[] = [];
beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "orc-channel-mcp-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ORC_DB_PATH = ":memory:";
  delete process.env.ORC_ACTIVE_PROJECT;
  resetConfig();
  createTestDb();
  getSqlite()
    .query("INSERT INTO projects (id,name) VALUES ('p1','channel-one'),('p2','channel-two')")
    .run();
  const transport: ChannelTransport = {
    identity: async () => ({ id: "team", name: "workspace" }),
    send: async (p) => {
      sent.push(p);
      return "1.0";
    },
    edit: async () => {},
    start: async () => {},
    stop: async () => {},
  };
  service = new ChannelService(new ChannelStore(getSqlite()), () => transport);
  await service.save({
    id: "slack",
    name: "Work Slack",
    provider: "slack",
    enabled: true,
    credentials: { bot_token: "private", app_token: "private-app" },
    targets: [{ id: "me", name: "Nir", chat_id: "D1", project_ids: ["p1"] }],
  });
  const router = createChannelsRouter(() => service);
  router.onError((err, c) => {
    if (err instanceof OrcError)
      return c.json({ error: err.message, code: err.code }, err.statusCode as 400);
    return c.json({ error: err instanceof Error ? err.message : "Internal Server Error" }, 500);
  });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (r) => {
      const url = new URL(r.url);
      url.pathname = url.pathname.replace(/^\/api/, "");
      return router.fetch(new Request(url.toString(), r));
    },
  });
  process.env.ORC_API_BASE = String(server.url).replace(/\/$/, "");
  resetConfig();
});
afterAll(async () => {
  await service?.stop();
  await server?.stop(true);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});

test("MCP discovery/send/status/edit use the real HTTP service and enforce selected projects", async () => {
  const options = { projectScopes: [{ id: "p1", name: "channel-one" }] };
  const listing = JSON.parse(await executeTool("channel_list", {}, options));
  expect(listing.connections.find((c: { id: string }) => c.id === "slack").targets).toHaveLength(1);
  expect(JSON.stringify(listing)).not.toContain("private-app");
  const input = {
    connection: "slack",
    target: "me",
    message: { text: "**Done**" },
    overrides: {
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Native*" } }],
      provider_future_option: ["a", { b: true }],
    },
    idempotency_key: "mcp",
  };
  const receipt = JSON.parse(await executeTool("channel_send", input, options));
  expect(receipt.status).toBe("accepted");
  expect(sent[0]).toMatchObject({ ...input.overrides, channel: "D1" });
  expect(JSON.parse(await executeTool("channel_send", input, options)).id).toBe(receipt.id);
  expect(sent).toHaveLength(1);
  expect(
    JSON.parse(await executeTool("channel_message_get", { id: receipt.id }, options)).status,
  ).toBe("accepted");
  expect(
    JSON.parse(
      await executeTool(
        "channel_message_update",
        { id: receipt.id, message: { text: "Updated" } },
        options,
      ),
    ).id,
  ).toBe(receipt.id);
  await expect(
    executeTool("channel_send", { ...input, project_id: "p2" }, options),
  ).rejects.toThrow("outside");
  const other = JSON.parse(
    await executeTool(
      "channel_targets",
      { channel_id: "slack" },
      { projectScopes: [{ id: "p2", name: "channel-two" }] },
    ),
  );
  expect(other).toEqual([]);

  await service.save({
    id: "1",
    name: "Personal Telegram",
    provider: "telegram",
    enabled: true,
    credentials: { token: "telegram-secret" },
    targets: [
      { id: "me", name: "Nir", chat_id: "111", project_ids: ["p1"] },
      { id: "ops", name: "Ops", chat_id: "222", project_ids: ["p1"] },
    ],
  });
  await service.save({
    id: "many",
    name: "Ops Slack",
    provider: "slack",
    enabled: true,
    credentials: { bot_token: "slack-secret", app_token: "slack-app" },
    targets: [
      { id: "ops", name: "Ops", chat_id: "C1", project_ids: ["p1"] },
      { id: "alerts", name: "Alerts", chat_id: "C2", project_ids: ["p1"] },
    ],
  });
  const before = sent.length;
  const generic = JSON.parse(
    await executeTool(
      "channel_send",
      {
        channel_id: "1",
        text: "dsdsd",
        overrides: { text: "<b>dsdsd</b>", parse_mode: "HTML", disable_notification: true },
      },
      options,
    ),
  );
  expect(generic).toMatchObject({ status: "accepted", connection: "1", target: "me" });
  expect(sent.at(-1)).toMatchObject({
    chat_id: "111",
    text: "<b>dsdsd</b>",
    parse_mode: "HTML",
    disable_notification: true,
  });
  expect(JSON.stringify(generic)).not.toContain("telegram-secret");
  const chosen = JSON.parse(
    await executeTool("channel_send", { channel_id: "1", target: "ops", text: "other" }, options),
  );
  expect(chosen.target).toBe("ops");
  expect(sent.at(-1)).toMatchObject({ chat_id: "222", text: "other" });
  await expect(
    executeTool("channel_send", { channel_id: "many", text: "dsdsd" }, options),
  ).rejects.toThrow("Pass target");
  expect(sent).toHaveLength(before + 2);
  expect(JSON.stringify(sent)).not.toContain("slack-secret");
});
