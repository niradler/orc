import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelConnectionSchema } from "@orc/core/channels";
import {
  NotificationFilterSchema,
  NotificationForwardingPolicySchema,
  notificationMatches,
} from "@orc/core/notifications";
import { ChannelStore } from "@orc/db/channels";
import { NotificationDeliveryStore } from "@orc/db/notification-deliveries";
import { publishJobNotification } from "@orc/db/notification-producers";
import { NotificationStore } from "@orc/db/notifications";
import { forwardChannelNotifications } from "./notifications.js";
import { type ChannelTransport, ProviderFailure } from "./providers.js";
import { ChannelService } from "./service.js";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE human_requests(id TEXT PRIMARY KEY,payload TEXT)");
  let now = 1000;
  const connection = ChannelConnectionSchema.parse({
    id: "test",
    name: "Test",
    provider: "telegram",
    enabled: true,
    targets: [{ id: "me", name: "Me", chat_id: "123", notifications: { enabled: true } }],
  });
  const payloads: Record<string, unknown>[] = [];
  let failure: ProviderFailure | null = null;
  const transport: ChannelTransport = {
    identity: async () => ({ id: "bot", name: "Fixture" }),
    start: async () => {},
    stop: async () => {},
    edit: async () => {},
    send: async (payload) => {
      if (failure) throw failure;
      payloads.push(payload);
      return String(payloads.length);
    },
  };
  const service = new ChannelService(new ChannelStore(db), () => transport);
  service.connections = () => [connection];
  const store = new NotificationDeliveryStore(db, () => now);
  store.syncDestinations([connection]);
  store.savePolicy({ enabled: true, base_url: "https://orc.example" });
  const publish = (type = "agent.finished", project: string | null = null) =>
    new NotificationStore(db, () => now).publish({
      type,
      source_key: `${type}:${now}`,
      source_id: `source-${now}`,
      title: "PRIVATE title token=secret",
      body: "PRIVATE command/question/tool payload",
      level: type.endsWith("finished") ? "done" : "needs-you",
      project_id: project,
      path: "/activity",
      created_at: now,
      expires_at: now + 1000000,
    });
  return {
    db,
    service,
    store,
    connection,
    payloads,
    publish,
    advance: (ms = 1) => {
      now += ms;
    },
    failure: (value: ProviderFailure | null) => {
      failure = value;
    },
    tick: () => forwardChannelNotifications(service, store),
    now: () => now,
  };
}

test("should match opt-in, known/unknown types, category, level, outcome and project intersections", () => {
  const event = { type: "job.failed", level: "needs-you" as const, project_id: "p1" };
  const matches = (raw: unknown, projects: string[] = []) =>
    notificationMatches(event, NotificationFilterSchema.parse(raw), projects);
  expect(matches({})).toBe(false);
  expect(matches({ enabled: true })).toBe(true);
  for (const filter of [
    { types: ["job.finished"] },
    { categories: ["agent"] },
    { levels: ["done"] },
    { outcomes: ["success"] },
  ])
    expect(matches({ enabled: true, ...filter })).toBe(false);
  expect(matches({ enabled: true, outcomes: ["failure"] }, ["p1"])).toBe(true);
  expect(matches({ enabled: true }, ["p2"])).toBe(false);
  expect(
    notificationMatches(
      { ...event, project_id: null },
      NotificationFilterSchema.parse({ enabled: true }),
      ["p1"],
    ),
  ).toBe(false);
  expect(
    notificationMatches(
      { ...event, type: "future.event" },
      NotificationFilterSchema.parse({ enabled: true }),
      [],
    ),
  ).toBe(false);
  expect(
    notificationMatches(
      { ...event, type: "future.event" },
      NotificationFilterSchema.parse({ enabled: true, include_unknown: true }),
      [],
    ),
  ).toBe(true);
  expect(
    notificationMatches(
      { ...event, type: "future.event" },
      NotificationFilterSchema.parse({
        enabled: true,
        include_unknown: true,
        outcomes: ["waiting"],
      }),
      [],
    ),
  ).toBe(false);
});
test("should reject unsafe link origins and enabling without an origin", () => {
  for (const base_url of [
    "",
    "javascript:alert(1)",
    "https://user:secret@host",
    "https://host/?token=secret",
    "https://host/#secret",
    "https://host/subpath",
  ])
    expect(NotificationForwardingPolicySchema.safeParse({ enabled: true, base_url }).success).toBe(
      false,
    );
});

test("should migrate existing channel storage additively and retain notification policies after reopening the store", () => {
  const f = fixture();
  const store = new ChannelStore(f.db);
  store.saveConnection(f.connection);
  const reopened = new ChannelStore(f.db).connections()[0];
  expect(reopened?.targets[0]?.notifications).toEqual(f.connection.targets[0]?.notifications);
  expect(
    f.db
      .query<{ name: string }, []>("PRAGMA table_info(channel_targets)")
      .all()
      .map((column) => column.name),
  ).not.toContain("notifications");
  if (!reopened) throw new Error("fixture");
  const target = reopened.targets[0];
  if (!target) throw new Error("fixture");
  target.notifications = undefined;
  store.saveConnection(reopened);
  expect(new ChannelStore(f.db).connections()[0]?.targets[0]?.notifications).toBeUndefined();
});
test("should forward a safe summary through the existing renderer and persist dedupe across restart", async () => {
  const f = fixture();
  f.advance();
  f.publish();
  await f.tick();
  expect(f.payloads).toHaveLength(1);
  expect(JSON.stringify(f.payloads)).not.toContain("PRIVATE");
  expect(JSON.stringify(f.payloads)).not.toContain("secret");
  expect(JSON.stringify(f.payloads)).toContain("https://orc.example/activity");
  expect(f.store.list()[0]?.status).toBe("delivered");
  await forwardChannelNotifications(f.service, new NotificationDeliveryStore(f.db, f.now));
  expect(f.payloads).toHaveLength(1);
});
test("should skip pre-opt-in history and notifications produced during a global pause", async () => {
  const f = fixture();
  f.store.savePolicy({ enabled: false });
  f.advance();
  f.publish();
  await f.tick();
  expect(f.payloads).toHaveLength(0);
  f.advance();
  f.store.savePolicy({ enabled: true, base_url: "https://orc.example" });
  await f.tick();
  expect(f.payloads).toHaveLength(0);
  f.advance();
  f.publish();
  await f.tick();
  expect(f.payloads).toHaveLength(1);
});
test("should recheck disabled, missing, changed, filtered and expired destinations before dispatch", async () => {
  for (const change of [
    "disabled",
    "missing",
    "outbound",
    "opt-out",
    "changed",
    "project",
    "expiry",
  ]) {
    const f = fixture();
    f.advance();
    f.publish();
    f.store.enqueue([f.connection]);
    const target = f.connection.targets[0];
    if (!target) throw new Error("fixture");
    if (change === "disabled") f.connection.enabled = false;
    if (change === "missing") f.connection.targets = [];
    if (change === "outbound") target.outbound = false;
    if (change === "opt-out" && target.notifications) target.notifications.enabled = false;
    if (change === "changed") target.chat_id = "456";
    if (change === "project") target.project_ids = ["p2"];
    if (change === "expiry") f.advance(1000001);
    await f.tick();
    expect(f.payloads).toHaveLength(0);
  }
});
test("should retry definite rate limits with backoff and stop after four attempts", async () => {
  const f = fixture();
  f.failure(new ProviderFailure("rate_limited"));
  f.advance();
  f.publish();
  await f.tick();
  expect(f.store.list()[0]?.attempts).toBe(1);
  expect(f.store.list()[0]?.status).toBe("pending");
  await f.tick();
  expect(f.store.list()[0]?.attempts).toBe(1);
  for (let i = 0; i < 3; i++) {
    f.advance(60001);
    await f.tick();
  }
  expect(f.store.list()[0]?.status).toBe("failed");
  expect(f.store.list()[0]?.attempts).toBe(4);
});
test("should recover a transient failure but never retry ambiguous or permanent failures", async () => {
  const f = fixture();
  f.failure(new ProviderFailure("rate_limited"));
  f.advance();
  f.publish();
  await f.tick();
  f.failure(null);
  f.advance(5000);
  await f.tick();
  expect(f.payloads).toHaveLength(1);
  expect(f.store.list()[0]?.attempts).toBe(2);
  for (const failure of [
    new ProviderFailure("network_or_timeout", true),
    new ProviderFailure("invalid_auth"),
  ]) {
    const g = fixture();
    g.failure(failure);
    g.advance();
    g.publish();
    await g.tick();
    g.failure(null);
    g.advance(150000);
    await g.tick();
    expect(g.payloads).toHaveLength(0);
    expect(g.store.list()[0]?.attempts).toBe(1);
  }
});
test("should reclaim interrupted work using the same transport idempotency key without resending accepted messages", async () => {
  const f = fixture();
  f.advance();
  const event = f.publish();
  if (!event) throw new Error("fixture");
  f.store.enqueue([f.connection]);
  const claim = f.store.claim("old-process");
  if (!claim) throw new Error("fixture");
  expect(f.store.claim("other-process")).toBeNull();
  const key = createHash("sha256")
    .update(JSON.stringify([event.id, "test", "me"]))
    .digest("hex");
  await f.service.send({
    connection: "test",
    target: "me",
    project_id: null,
    idempotency_key: `notification:${key}:1`,
    message: {
      text: "An agent finished its reply in ORC.",
      format: "plain",
      links: [{ label: "Open in ORC", url: "https://orc.example/activity" }],
    },
  });
  f.db.query("UPDATE channel_receipts SET updated_at=?").run(f.now() - 31 * 86400000);
  new ChannelStore(f.db, f.now).prune();
  f.advance(120001);
  await f.tick();
  expect(f.payloads).toHaveLength(1);
  expect(f.store.list()[0]?.status).toBe("delivered");
});
test("should respect human-request producer provider selection without forwarding private request payloads", async () => {
  const f = fixture();
  f.advance();
  const event = f.publish("human.request");
  if (!event) throw new Error("fixture");
  f.db
    .query("INSERT INTO human_requests VALUES(?,?)")
    .run(event.source_id, JSON.stringify({ notify: [], prompt: "PRIVATE" }));
  await f.tick();
  expect(f.payloads).toHaveLength(0);
  f.advance();
  const next = f.publish("human.request");
  if (!next) throw new Error("fixture");
  f.db
    .query("INSERT INTO human_requests VALUES(?,?)")
    .run(next.source_id, JSON.stringify({ notify: ["telegram"], prompt: "PRIVATE" }));
  await f.tick();
  expect(f.payloads).toHaveLength(1);
  expect(JSON.stringify(f.payloads)).not.toContain("PRIVATE");
});
test("should advance past filtered rows in bounded scans instead of starving later notifications", async () => {
  const f = fixture();
  for (let i = 0; i < 125; i++) {
    f.advance();
    f.publish("future.event");
  }
  f.advance();
  f.publish();
  await f.tick();
  expect(f.payloads).toHaveLength(0);
  await f.tick();
  expect(f.payloads).toHaveLength(1);
});

test("should keep pending and successful deliveries across actual database close/reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orc-notification-delivery-"));
  let db = new Database(join(directory, "state.db"));
  const payloads: Record<string, unknown>[] = [];
  const transport: ChannelTransport = {
    identity: async () => ({ id: "bot", name: "Fixture" }),
    start: async () => {},
    stop: async () => {},
    edit: async () => {},
    send: async (payload) => {
      payloads.push(payload);
      return "accepted";
    },
  };
  try {
    const channels = new ChannelStore(db);
    channels.saveConnection(
      ChannelConnectionSchema.parse({
        id: "persist",
        name: "Persisted",
        provider: "slack",
        enabled: true,
        targets: [{ id: "me", name: "Me", chat_id: "channel", notifications: { enabled: true } }],
      }),
    );
    const store = new NotificationDeliveryStore(db, () => 1000);
    store.syncDestinations(channels.connections());
    store.savePolicy({ enabled: true, base_url: "https://orc.example" });
    new NotificationStore(db, () => 1001).publish({
      type: "job.failed",
      source_key: "persistent",
      source_id: "run",
      title: "PRIVATE",
      body: "PRIVATE",
      level: "needs-you",
      path: "/jobs/job?run=run",
      created_at: 1001,
      expires_at: 1000000,
    });
    store.enqueue(channels.connections());
    expect(store.list()[0]?.status).toBe("pending");
    db.close();
    db = new Database(join(directory, "state.db"));
    for (let restart = 0; restart < 2; restart++) {
      const persisted = new ChannelStore(db);
      const service = new ChannelService(persisted, () => transport);
      service.connections = () => persisted.connections();
      await forwardChannelNotifications(service, new NotificationDeliveryStore(db, () => 2000));
      expect(new NotificationDeliveryStore(db, () => 2000).list()[0]?.status).toBe("delivered");
      expect(payloads).toHaveLength(1);
      db.close();
      db = new Database(join(directory, "state.db"));
    }
    expect(JSON.stringify(payloads)).not.toContain("PRIVATE");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("should forward only job events allowed by the common notify_on producer", async () => {
  const f = fixture();
  f.db.exec(
    "CREATE TABLE jobs(id TEXT PRIMARY KEY,name TEXT,notify_on TEXT,project_id TEXT); CREATE TABLE job_runs(id TEXT PRIMARY KEY,job_id TEXT,status TEXT,ended_at INTEGER)",
  );
  for (const [index, policy, status] of [
    [1, "never", "failed"],
    [2, "failure", "success"],
    [3, "failure", "failed"],
    [4, "always", "success"],
  ] as const) {
    f.advance();
    f.db.query("INSERT INTO jobs VALUES(?,?,?,NULL)").run(String(index), "PRIVATE job", policy);
    f.db.query("INSERT INTO job_runs VALUES(?,?,?,NULL)").run(String(index), String(index), status);
    publishJobNotification(f.db, String(index));
  }
  // Production timestamps come from the producer's clock; advance the injected dispatcher accordingly.
  f.advance(Date.now());
  await f.tick();
  expect(f.payloads).toHaveLength(2);
  expect(JSON.stringify(f.payloads)).not.toContain("PRIVATE");
});

test("should clean expired delivery rows while paused and stop before starting another send", async () => {
  const f = fixture();
  f.advance();
  f.publish();
  f.store.enqueue([f.connection]);
  await forwardChannelNotifications(f.service, f.store, () => true);
  expect(f.payloads).toHaveLength(0);
  f.store.savePolicy({ enabled: false });
  f.advance(1000001);
  await f.tick();
  expect(f.store.list()).toEqual([]);
});
