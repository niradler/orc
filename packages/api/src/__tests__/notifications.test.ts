import { afterAll, beforeAll, expect, test } from "bun:test";
import type { HumanRequest } from "@orc/core/human-requests";
import type { NotificationPage, OrcNotification } from "@orc/core/notifications";
import { getSqlite } from "@orc/db/client";
import { publishJobNotification } from "@orc/db/notification-producers";
import { NotificationStore } from "@orc/db/notifications";
import { executeJob } from "@orc/runner/executor";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(teardownTestApp);

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
