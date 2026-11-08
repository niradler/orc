import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ChatEvent, ChatSettingsSchema, ChatThreadSchema } from "@orc/core/chat";
import type { HumanRequest } from "@orc/core/human-requests";
import type { NotificationPage, OrcNotification } from "@orc/core/notifications";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import { publishJobNotification } from "@orc/db/notification-producers";
import { NotificationStore } from "@orc/db/notifications";
import { executeJob } from "@orc/runner/executor";
import {
  recordChatNotification,
  recordObservedNotification,
  retireChatFinishedNotifications,
} from "../notifications.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(teardownTestApp);

test("should keep one completion at the last active chat, isolating backend and execution host", async () => {
  const sqlite = getSqlite();
  const chats = new ChatStore(sqlite);
  const runtimeId = crypto.randomUUID();
  const nativeSourceId = `old-native-${runtimeId}`;
  const base = {
    title: "Session identity fixture",
    config: ChatSettingsSchema.parse({}),
    cwd: process.cwd(),
    runtimeId,
    sourceId: null,
    messages: [],
    updatedAt: Date.now(),
  };
  const first = ChatThreadSchema.parse({
    ...base,
    id: crypto.randomUUID(),
    backend: "codex-cli",
    host: null,
    sourceId: nativeSourceId,
  });
  const viewed = ChatThreadSchema.parse({
    ...base,
    id: crypto.randomUUID(),
    backend: "codex",
    host: null,
    sourceId: nativeSourceId,
  });
  const remote = ChatThreadSchema.parse({
    ...base,
    id: crypto.randomUUID(),
    backend: "codex-cli",
    host: "fixture-lab",
  });
  const otherBackend = ChatThreadSchema.parse({
    ...base,
    id: crypto.randomUUID(),
    backend: "claude",
    host: null,
  });
  chats.save(first);
  const now = Date.now();
  new NotificationStore(sqlite).publish({
    type: "agent.finished",
    source_key: `old-native:${runtimeId}`,
    source_id: nativeSourceId,
    title: "Earlier native turn",
    level: "done",
    path: "/sessions",
    created_at: now - 1000,
    expires_at: now + 60000,
  });
  recordChatNotification(first, "first", "finished");
  expect(
    sqlite.query("SELECT id FROM notifications WHERE source_id=?").get(nativeSourceId),
  ).toBeNull();
  const notifications = new NotificationStore(sqlite);
  const sources = new Set([first.id, viewed.id, remote.id, otherBackend.id]);
  const completions = () =>
    notifications
      .list()
      .notifications.filter(
        (item) => item.type === "agent.finished" && sources.has(item.source_id),
      );
  chats.save(viewed);
  expect(completions().map((item) => item.source_id)).toEqual([first.id]);
  for (const thread of [remote, otherBackend]) {
    chats.save(thread);
    recordChatNotification(thread, "separate", "finished");
  }
  await Bun.sleep(2);
  recordChatNotification(viewed, "active-turn", "finished");
  expect(completions()).toHaveLength(3);
  expect(completions().some((item) => item.source_id === first.id)).toBe(false);
  expect(completions().find((item) => item.source_id === viewed.id)?.path).toContain(
    `chatThread=${viewed.id}`,
  );
  retireChatFinishedNotifications(first);
  expect(completions().find((item) => item.source_id === viewed.id)?.read_at).not.toBeNull();
  expect(completions().filter((item) => item.read_at === null)).toHaveLength(2);
  expect(
    sqlite
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM notifications WHERE source_id=? AND type='agent.finished'",
      )
      .get(first.id)?.count,
  ).toBe(0);
});

test("should backfill existing chat aliases before listing and remove superseded physical rows", async () => {
  const sqlite = getSqlite();
  const runtimeId = crypto.randomUUID();
  const chats = new ChatStore(sqlite);
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const thread = ChatThreadSchema.parse({
      id: crypto.randomUUID(),
      title: "Legacy view",
      config: ChatSettingsSchema.parse({}),
      cwd: process.cwd(),
      host: null,
      runtimeId,
      backend: "codex-cli",
      sourceId: null,
      messages: [],
      updatedAt: Date.now(),
    });
    chats.save(thread);
    ids.push(thread.id);
    const now = Date.now();
    new NotificationStore(sqlite).publish({
      type: "agent.finished",
      source_id: thread.id,
      source_key: `legacy-view:${thread.id}`,
      title: "Legacy completion",
      level: "done",
      path: `/activity?chatThread=${thread.id}`,
      created_at: now + index,
      expires_at: now + 60000,
    });
  }
  const response = await req(app, "GET", "/notifications");
  expect(response.status).toBe(200);
  const items = (await response.json<NotificationPage>()).notifications.filter((item) =>
    ids.includes(item.source_id),
  );
  const latestId = ids[1];
  if (!latestId) throw new Error("Missing latest view");
  expect(items.map((item) => item.source_id)).toEqual([latestId]);
  expect(
    sqlite
      .query<{ count: number }, [string, string]>(
        "SELECT count(*) AS count FROM notifications WHERE source_id IN (?,?)",
      )
      .get(ids[0] ?? "", ids[1] ?? "")?.count,
  ).toBe(1);
});

test("should leave a completed turn linked to its active chat and move the next native turn to its native location", async () => {
  const sqlite = getSqlite();
  const runtimeId = crypto.randomUUID();
  const nativeId = `observed-${runtimeId}`;
  const thread = ChatThreadSchema.parse({
    id: crypto.randomUUID(),
    title: "Active location",
    config: ChatSettingsSchema.parse({}),
    cwd: process.cwd(),
    host: null,
    runtimeId,
    backend: "codex-cli",
    sourceId: null,
    messages: [],
    updatedAt: Date.now(),
  });
  new ChatStore(sqlite).save(thread);
  recordChatNotification(thread, "managed-turn", "finished");
  const event = {
    id: nativeId,
    backend: "codex",
    host: null,
    nativeId: runtimeId,
    title: "Native location",
    projectId: null,
    previous: "running",
    status: "idle",
    waiting: false,
    wasWaiting: false,
    activity: Date.now() - 1000,
  };
  recordObservedNotification(event, () => true);
  const store = new NotificationStore(sqlite);
  const items = () =>
    store.list().notifications.filter((item) => [thread.id, nativeId].includes(item.source_id));
  expect(items()).toHaveLength(1);
  expect(items()[0]?.path).toContain(`chatThread=${thread.id}`);
  recordObservedNotification(
    { ...event, previous: "idle", status: "running", activity: Date.now() },
    () => true,
  );
  expect(items()[0]?.read_at).not.toBeNull();
  await Bun.sleep(2);
  recordObservedNotification({ ...event, activity: Date.now() }, () => true);
  await Bun.sleep(1100);
  expect(items()).toHaveLength(1);
  expect(items()[0]?.path).toContain(`session=${nativeId}`);
  expect(items()[0]?.read_at).toBeNull();
  expect(sqlite.query("SELECT id FROM notifications WHERE source_id=?").get(thread.id)).toBeNull();
});

test("should store only the latest managed turn completion", async () => {
  const previousMock = process.env.ORC_E2E_CHAT_MOCK;
  process.env.ORC_E2E_CHAT_MOCK = "1";
  try {
    const first = await req(app, "POST", "/chat/stream", {
      messages: [{ role: "user", content: "First turn" }],
    });
    expect(first.status).toBe(200);
    const events = (await first.text())
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line): ChatEvent => JSON.parse(line.slice(5)));
    const event = events.find((event) => event.type === "thread");
    if (event?.type !== "thread") throw new Error("Missing thread event");
    const thread = ChatThreadSchema.parse(event.thread);
    const store = new NotificationStore(getSqlite());
    const previous = store.list().notifications.find((item) => item.source_id === thread.id);
    expect(previous?.type).toBe("agent.finished");
    expect(previous?.read_at).toBeNull();
    const next = await req(app, "POST", "/chat/stream", {
      threadId: thread.id,
      messages: [{ role: "user", content: "Continue" }],
    });
    expect(next.status).toBe(200);
    await next.text();
    const history = store.list().notifications.filter((item) => item.source_id === thread.id);
    expect(history).toHaveLength(1);
    expect(history.some((item) => item.id === previous?.id)).toBe(false);
    expect(history.filter((item) => item.read_at === null)).toHaveLength(1);
  } finally {
    if (previousMock === undefined) delete process.env.ORC_E2E_CHAT_MOCK;
    else process.env.ORC_E2E_CHAT_MOCK = previousMock;
  }
});

test("should retire observed completion alerts when the same session runs again", () => {
  const store = new NotificationStore(getSqlite());
  const now = Date.now();
  const item = store.publish({
    type: "agent.finished",
    source_key: "observed:continued:old",
    source_id: "continued",
    title: "Finished",
    level: "done",
    path: "/sessions",
    created_at: now,
    expires_at: now + 60000,
  });
  recordObservedNotification(
    {
      id: "continued",
      backend: "codex",
      host: null,
      nativeId: "native-continued",
      title: "Continued",
      projectId: null,
      previous: "idle",
      status: "running",
      waiting: false,
      wasWaiting: false,
      activity: now,
    },
    () => true,
  );
  expect(store.list().notifications.find((entry) => entry.id === item?.id)?.read_at).not.toBeNull();
  expect(store.list(50, 0, true).notifications.some((entry) => entry.id === item?.id)).toBe(false);
});

test("should authenticate notification operations and reject invalid inputs", async () => {
  for (const [method, path] of [
    ["GET", "/notifications"],
    ["PATCH", "/notifications/missing"],
    ["POST", "/notifications/read"],
  ] as const)
    expect((await app.request(`/api${path}`, { method })).status).toBe(401);
  for (const query of ["limit=0", "limit=101", "offset=-1", "unread=bad"])
    expect((await req(app, "GET", `/notifications?${query}`)).status).toBe(400);
  expect((await req(app, "PATCH", "/notifications/missing", {})).status).toBe(400);
});

test("should preserve generic types and share read/dismissal state without replaying sources", async () => {
  const now = Date.now();
  const store = new NotificationStore(getSqlite());
  const item = store.publish({
    type: "future.custom",
    source_key: "custom:api",
    source_id: "custom",
    title: "A future event",
    level: "done",
    path: "/activity",
    created_at: now,
    expires_at: now + 86400000,
  });
  if (!item) throw new Error("Expected notification");
  expect(
    (await (await req(app, "GET", "/notifications")).json<NotificationPage>()).notifications.some(
      (entry) => entry.type === "future.custom",
    ),
  ).toBe(true);
  expect((await req(app, "PATCH", `/notifications/${item.id}`, { read: true })).status).toBe(200);
  expect(
    (
      await (
        await req(app, "PATCH", `/notifications/${item.id}`, { dismissed: true })
      ).json<OrcNotification>()
    ).read_at,
  ).not.toBeNull();
  expect(
    (await (await req(app, "GET", "/notifications")).json<NotificationPage>()).notifications.some(
      (entry) => entry.id === item.id,
    ),
  ).toBe(false);
});

test("should connect human requests to history and keep notification dismissal independent", async () => {
  const response = await req(app, "POST", "/human-requests", {
    kind: "question",
    prompt: "Which color?",
    choices: ["Blue", "Green"],
    origin: { backend: "test", session_id: "notification-request", request_id: "color" },
  });
  expect(response.status).toBe(200);
  const request = await response.json<HumanRequest>();
  const page = await (await req(app, "GET", "/notifications")).json<NotificationPage>();
  const notification = page.notifications.find(
    (entry) => entry.type === "human.request" && entry.source_id === request.id,
  );
  if (!notification) throw new Error("Missing request notification");
  await req(app, "PATCH", `/notifications/${notification.id}`, { dismissed: true });
  expect(
    (await (await req(app, "GET", `/human-requests/${request.id}`)).json<HumanRequest>()).status,
  ).toBe("pending");
  const answered = await req(app, "POST", `/human-requests/${request.id}/respond`, {
    version: request.version,
    response: { kind: "question", answer: "Blue" },
  });
  expect(answered.status).toBe(200);
  const row = getSqlite()
    .query<{ requires_action: number }, [string]>(
      "SELECT requires_action FROM notifications WHERE id=?",
    )
    .get(notification.id);
  expect(row?.requires_action).toBe(0);
});

test("should expire notifications and retain their independent audit events", async () => {
  const sqlite = getSqlite();
  const now = Date.now();
  const item = new NotificationStore(sqlite).publish({
    type: "custom.expiry",
    source_key: "api:expires",
    source_id: "expiring",
    title: "Expiring alert",
    level: "done",
    path: "/activity",
    created_at: now,
    expires_at: now + 86400000,
  });
  if (!item) throw new Error("Expected notification");
  sqlite.query("UPDATE notifications SET expires_at=? WHERE id=?").run(now - 1, item.id);
  expect(
    (await (await req(app, "GET", "/notifications")).json<NotificationPage>()).notifications.some(
      (entry) => entry.id === item.id,
    ),
  ).toBe(false);
  const audit = await (
    await req(app, "GET", "/audit?entity_type=notification&scope=all&snapshot=preview")
  ).json<{ entries: { action: string; subject_ids: string[] }[] }>();
  expect(
    audit.entries.some(
      (entry) => entry.action === "notification.expired" && entry.subject_ids.includes(item.id),
    ),
  ).toBe(true);
});

test("should let a person inspect an answer without claiming the agent received it", async () => {
  const created = await (
    await req(app, "POST", "/human-requests", {
      kind: "question",
      prompt: "A reply nobody collected",
      origin: { backend: "test", session_id: "view-only", request_id: "view" },
    })
  ).json<HumanRequest>();
  const answered = await (
    await req(app, "POST", `/human-requests/${created.id}/respond`, {
      version: created.version,
      response: { kind: "question", answer: "A response" },
    })
  ).json<HumanRequest>();
  for (let attempt = 0; attempt < 2; attempt++) {
    const viewed = await (
      await req(app, "GET", `/human-requests/${created.id}/view`)
    ).json<HumanRequest>();
    expect(viewed.seen_at).toBeNull();
    expect(viewed.status).toBe("answered");
  }
  expect(
    (await req(app, "POST", `/human-requests/${created.id}/cancel`, { version: answered.version }))
      .status,
  ).toBe(200);
});

test("should publish real job outcomes according to notify_on and deduplicate repeats", async () => {
  for (const [policy, exit] of [
    ["always", 0],
    ["failure", 0],
    ["failure", 1],
    ["never", 1],
  ] as const) {
    const job = await (
      await req(app, "POST", "/jobs", {
        name: `notification-${policy}-${exit}`,
        trigger_type: "manual",
        command: "notification fixture",
        notify_on: policy,
      })
    ).json<{ id: string }>();
    const runId = await executeJob({
      jobId: job.id,
      execution: {
        argv: [process.execPath, "-e", `process.exit(${exit})`],
        stdin: "",
        timeout_ms: 10000,
        cwd: process.cwd(),
      },
    });
    publishJobNotification(getSqlite(), runId);
    const row = getSqlite()
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM notifications WHERE source_key=?",
      )
      .get(`job:${runId}`);
    expect(row?.count).toBe(policy === "always" || (policy === "failure" && exit !== 0) ? 1 : 0);
  }
  const failed = getSqlite()
    .query<{ title: string; body: string; path: string }, []>(
      "SELECT title, body, path FROM notifications WHERE title LIKE 'notification-failure-1 %'",
    )
    .get();
  expect(failed?.title).toBe("notification-failure-1 failed");
  expect(failed?.body).toMatch(/after \d+s, exit 1/);
  expect(failed?.body).toContain("Open the run for logs.");
  expect(failed?.path).toContain("run=");
});
