import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  ChannelConnectionSchema,
  type ChannelInbound,
  ChannelRouteSchema,
} from "@orc/core/channels";
import { ChannelStore } from "@orc/db/channels";
import { slackInbound } from "./providers/slack.js";
import { inTimeWindow, routeMessage } from "./routing.js";
import { ChannelService } from "./service.js";

const dm: ChannelInbound = {
  connection: "slack",
  sender: "U1",
  chat: "D1",
  text: "Please DEPLOY the api",
  message_id: "D1:1",
  kind: "message",
  is_direct: true,
  is_mention: false,
};
const agent = { type: "agent", agent: "codex", project_id: "p" };
const route = (id: string, condition: unknown, action: unknown = agent) =>
  ChannelRouteSchema.parse({ id, name: id, condition, action });
const at = (iso: string) => new Date(iso);

test("time windows honor the timezone, weekdays and overnight ranges", () => {
  const workday = { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00", tz: "Asia/Jerusalem" };
  expect(inTimeWindow(workday, at("2026-11-16T07:30:00Z"))).toBe(true);
  expect(inTimeWindow(workday, at("2026-11-16T16:00:00Z"))).toBe(false);
  expect(inTimeWindow(workday, at("2026-11-21T08:00:00Z"))).toBe(false);
  const night = { days: [1], from: "22:00", to: "06:00", tz: "UTC" };
  expect(inTimeWindow(night, at("2026-11-16T23:00:00Z"))).toBe(true);
  expect(inTimeWindow(night, at("2026-11-17T05:59:00Z"))).toBe(true);
  expect(inTimeWindow(night, at("2026-11-17T23:00:00Z"))).toBe(false);
  expect(inTimeWindow(night, at("2026-11-16T05:00:00Z"))).toBe(false);
});

test("AND/OR rules combine keywords, time and direct messages; first match wins", () => {
  const afterHours = route("after-hours", {
    all: [
      { field: "is_direct", op: "is", value: true },
      { not: { time: { from: "09:00", to: "18:00", tz: "UTC" } } },
    ],
  });
  const keywords = route("keywords", {
    any: [
      { field: "text", op: "contains_any", value: ["deploy", "rollback"] },
      { field: "command", op: "is", value: "ship" },
    ],
  });
  const fallback = route("otherwise", { always: true }, { type: "ignore" });
  const routes = [afterHours, keywords, fallback];
  expect(routeMessage(routes, dm, at("2026-11-16T20:00:00Z"))?.id).toBe("after-hours");
  expect(routeMessage(routes, dm, at("2026-11-16T10:00:00Z"))?.id).toBe("keywords");
  expect(routeMessage(routes, { ...dm, text: "hello" }, at("2026-11-16T10:00:00Z"))?.id).toBe(
    "otherwise",
  );
  expect(routeMessage(routes, { ...dm, text: "/ship" }, at("2026-11-16T10:00:00Z"))?.id).toBe(
    "keywords",
  );
});

test("rule validation rejects regex, bad clocks, unknown zones and empty keyword lists", () => {
  for (const condition of [
    { field: "text", op: "matches", value: "(a+)+" },
    { time: { from: "9:00", to: "18:00" } },
    { time: { from: "09:00", to: "18:00", tz: "Mars/Olympus" } },
    { time: { from: "09:00", to: "18:00", days: [7] } },
    { field: "text", op: "contains_any", value: [] },
    { time: { from: "09:00", to: "09:00" } },
  ])
    expect(() => route("bad", condition)).toThrow();
  expect(route("job", { always: true }, { type: "job", job_id: "j1" }).action).toEqual({
    type: "job",
    job_id: "j1",
  });
  expect(route("defaults", { always: true }).action).toMatchObject({
    session: "continue",
    permissions: "ask",
  });
});

test("an any-chat destination cannot carry notifications, approvals or a thread", () => {
  const base = { id: "c", name: "c", provider: "slack" };
  expect(() =>
    ChannelConnectionSchema.parse({
      ...base,
      targets: [{ id: "any", name: "any", chat_id: "*", user_ids: ["*"], attention: true }],
    }),
  ).toThrow();
  expect(() =>
    ChannelConnectionSchema.parse({
      ...base,
      targets: [
        { id: "team", name: "team", chat_id: "C1", user_ids: ["U1", "*"], attention: true },
      ],
    }),
  ).toThrow();
  expect(
    ChannelConnectionSchema.parse({
      ...base,
      targets: [{ id: "any", name: "any", chat_id: "*", user_ids: ["*"], inbound: true }],
    }).targets[0]?.chat_id,
  ).toBe("*");
});

test("wildcard targets accept any DM sender, flag followups and dispatch job routes", async () => {
  const db = new Database(":memory:");
  const service = new ChannelService(new ChannelStore(db));
  db.run("CREATE TABLE jobs (id TEXT PRIMARY KEY, project_id TEXT)");
  db.run("INSERT INTO jobs VALUES ('j1', NULL)");
  const handled: Array<{ route: string; followup: boolean | undefined; target: string }> = [];
  service.handler = async (route, message, target) => {
    handled.push({ route: route.id, followup: message.is_followup, target: target.id });
  };
  service.followup = (message) => message.thread === "T1";
  service.connections = () => [
    ChannelConnectionSchema.parse({
      id: "slack",
      name: "Slack",
      provider: "slack",
      enabled: true,
      targets: [
        { id: "me", name: "Me", chat_id: "D1", user_ids: ["U1"], inbound: true },
        { id: "anyone", name: "Any DM", chat_id: "*", user_ids: ["*"], inbound: true },
      ],
      routes: [
        route("followups", { field: "is_followup", op: "is", value: true }),
        route(
          "strangers",
          { field: "is_direct", op: "is", value: true },
          { type: "job", job_id: "j1" },
        ),
      ],
    }),
  ];
  await service.receive(dm);
  await service.receive({ ...dm, sender: "U9", chat: "D9", message_id: "D9:1" });
  await service.receive({ ...dm, message_id: "D1:2", thread: "T1", is_direct: false });
  expect(handled).toEqual([
    { route: "strangers", followup: false, target: "me" },
    { route: "strangers", followup: false, target: "anyone" },
    { route: "followups", followup: true, target: "me" },
  ]);
  db.close();
});

test("Slack inbound keeps thread roots, strips the bot mention and keeps shared files", () => {
  const message = slackInbound(
    {
      type: "events_api",
      envelope_id: "e1",
      payload: {
        team_id: "T",
        event: {
          type: "app_mention",
          user: "U1",
          channel: "C1",
          ts: "100.1",
          subtype: "file_share",
          text: "<@B1> look at   this",
          files: [
            {
              name: "log.txt",
              mimetype: "text/plain",
              size: 10,
              url_private_download: "https://files.slack.com/files-pri/T-F/log.txt",
            },
            { name: "evil", url_private_download: "https://evil.example/x" },
          ],
        },
      },
    },
    "slack",
    "B1",
  );
  expect(message).toMatchObject({
    chat: "C1",
    root: "100.1",
    text: "look at this",
    is_mention: true,
    is_direct: false,
    attachments: [{ name: "log.txt", mimeType: "text/plain", size: 10 }],
  });
  expect(message?.thread).toBeUndefined();
  expect(
    slackInbound(
      { payload: { event: { user: "B1", bot_id: "x", channel: "C1", text: "hi", ts: "1" } } },
      "slack",
      "B1",
    ),
  ).toBeNull();
  expect(
    slackInbound(
      {
        payload: {
          event: { user: "U1", channel: "C1", text: "x", ts: "2", subtype: "message_changed" },
        },
      },
      "slack",
      "B1",
    ),
  ).toBeNull();
  expect(
    slackInbound(
      {
        payload: {
          event: {
            user: "U1",
            channel: "D1",
            channel_type: "im",
            text: "x",
            ts: "3",
            thread_ts: "1",
          },
        },
      },
      "slack",
      "B1",
    ),
  ).toMatchObject({ thread: "1", is_direct: true });
});

test("any-chat destinations refuse API sends, and job routes obey destination projects", async () => {
  const db = new Database(":memory:");
  const store = new ChannelStore(db);
  db.run("CREATE TABLE jobs (id TEXT PRIMARY KEY, project_id TEXT)");
  db.run("INSERT INTO jobs VALUES ('j-other','p2')");
  const sent: Record<string, unknown>[] = [];
  const service = new ChannelService(store, () => ({
    identity: async () => ({ id: "T", name: "T" }),
    send: async (payload) => {
      sent.push(payload);
      return String(sent.length);
    },
    edit: async () => {},
    start: async () => {},
    stop: async () => {},
  }));
  const handled: string[] = [];
  service.handler = async (route) => {
    handled.push(route.id);
  };
  service.connections = () => [
    ChannelConnectionSchema.parse({
      id: "slack",
      name: "Slack",
      provider: "slack",
      enabled: true,
      targets: [
        {
          id: "anyone",
          name: "Any DM",
          chat_id: "*",
          user_ids: ["*"],
          inbound: true,
          project_ids: ["p1"],
        },
      ],
      routes: [route("job", { always: true }, { type: "job", job_id: "j-other" })],
    }),
  ];
  const message = { connection: "slack", target: "anyone", chat_id: "C9", message: { text: "hi" } };
  await expect(service.send(message)).rejects.toThrow("only carries replies");
  expect((await service.send(message, true)).status).toBe("accepted");
  expect(sent.at(-1)).toMatchObject({ channel: "C9" });
  await service.receive({ ...dm, sender: "U9", chat: "D9", message_id: "D9:1" });
  expect(handled).toEqual([]);
  db.close();
});

test("thread sessions queue a top-level message and its thread replies from anyone in order", async () => {
  const db = new Database(":memory:");
  const service = new ChannelService(new ChannelStore(db));
  const events: string[] = [];
  service.handler = async (_route, message) => {
    events.push(`start ${message.message_id}`);
    await Bun.sleep(20);
    events.push(`end ${message.message_id}`);
  };
  service.connections = () => [
    ChannelConnectionSchema.parse({
      id: "slack",
      name: "Slack",
      provider: "slack",
      enabled: true,
      targets: [{ id: "team", name: "Team", chat_id: "C1", user_ids: ["U1", "U2"], inbound: true }],
      routes: [route("all", { always: true }, { ...agent, session: "thread" })],
    }),
  ];
  const base = { ...dm, chat: "C1", is_direct: false };
  await Promise.all([
    service.receive({ ...base, message_id: "C1:1", root: "1.0" }),
    service.receive({ ...base, sender: "U2", message_id: "C1:2", thread: "1.0", root: "2.0" }),
  ]);
  expect(events).toEqual(["start C1:1", "end C1:1", "start C1:2", "end C1:2"]);
  db.close();
});

test("a stored rule that no longer validates is skipped instead of breaking the connection", () => {
  const db = new Database(":memory:");
  const store = new ChannelStore(db);
  store.saveConnection(
    ChannelConnectionSchema.parse({
      id: "c",
      name: "c",
      provider: "slack",
      routes: [route("good", { always: true }, { type: "ignore" })],
    }),
  );
  db.run(
    `INSERT INTO channel_routes (channel_id,id,name,enabled,position,condition,action) VALUES ('c','stale','stale',1,0,'{"always":true}','{"type":"agent","agent":"x","project_id":"p","permission_mode":"plan"}')`,
  );
  expect(store.connections()[0]?.routes.map((r) => r.id)).toEqual(["good"]);
  db.close();
});
