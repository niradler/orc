import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { AuditLog, cleanupAuditLog, installAudit, recordNotificationAudit } from "../audit.js";
import { NotificationStore } from "../notifications.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const databases: Database[] = [];

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

function setup() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  let now = Date.UTC(2026, 0, 1);
  installAudit(sqlite);
  const notifications = new NotificationStore(sqlite, () => now);
  return {
    sqlite,
    notifications,
    audit: new AuditLog(sqlite, { now: () => now, retentionDays: () => 90 }),
    input: {
      type: "human.request",
      source_key: "request:opaque-id",
      source_id: "opaque-id",
      title: "Private request title",
      body: "secret command and full question text",
      level: "needs-you" as const,
      path: "/sessions?session=opaque-session",
      project_id: "project-id",
      requires_action: true,
      created_at: now,
      expires_at: now + 30 * DAY_MS,
    },
    setNow(value: number) {
      now = value;
    },
  };
}

test("should audit meaningful notification changes without polling or repeated-state noise", () => {
  const { notifications, audit, input } = setup();
  const entry = notifications.publish(input);
  expect(entry).not.toBeNull();
  const id = entry?.id ?? "missing";
  notifications.publish(input);
  notifications.list();
  notifications.update(id, { read: true });
  notifications.update(id, { read: true });
  notifications.markAllRead();
  notifications.update(id, { read: false });
  notifications.update(id, { dismissed: true });
  notifications.update(id, { dismissed: true });
  notifications.update(id, { dismissed: false });
  notifications.resolve(input.source_key);
  notifications.resolve(input.source_key);
  expect(audit.list({ entityType: "notification" }).map((event) => event.action)).toEqual([
    "notification.resolved",
    "notification.restored",
    "notification.dismissed",
    "notification.unread",
    "notification.read",
    "notification.created",
  ]);
});

test("should retain the actual notification content in audit after the alert is cleaned up", () => {
  const { sqlite, notifications, audit, input, setNow } = setup();
  const item = notifications.publish(input);
  if (!item) throw new Error("Expected a notification before its expiry");
  setNow(input.expires_at);
  expect(notifications.cleanup()).toBe(1);
  expect(notifications.list().notifications).toEqual([]);
  const events = audit.list({ entityType: "notification" });
  expect(events.map((event) => event.action)).toEqual([
    "notification.expired",
    "notification.created",
  ]);
  expect(events[0]?.subject_ids).toEqual([item.id]);
  expect(events[0]?.project_id).toBe("project-id");
  expect(events[0]?.actor).toBeNull();
  for (const event of events) {
    const serialized = JSON.stringify(event);
    expect(event.snapshot).toMatchObject({ title: input.title, body: input.body });
    expect(serialized).not.toContain(input.path);
    expect(serialized.length).toBeLessThan(1000);
  }
  expect(cleanupAuditLog(sqlite, 90, input.expires_at)).toBe(0);
  expect(cleanupAuditLog(sqlite, 90, input.created_at + 90 * DAY_MS)).toBe(1);
  expect(audit.list({ entityType: "notification" }).map((event) => event.action)).toEqual([
    "notification.expired",
  ]);
  expect(cleanupAuditLog(sqlite, 90, input.expires_at + 90 * DAY_MS)).toBe(1);
  expect(audit.list()).toEqual([]);
});

test("should retain bounded notification text without copying unrelated source payloads", () => {
  const { sqlite, audit, input } = setup();
  const item = {
    ...input,
    id: "notification-id",
    read_at: null,
    dismissed_at: null,
    title: "t".repeat(200),
    body: "b".repeat(500),
    source_prompt: "Unrelated full human request prompt",
    command: { script: "Unrelated executable source command" },
    response: "Unrelated full source response",
  };
  recordNotificationAudit(sqlite, "notification.created", item, { now: () => input.created_at });
  const entry = audit.list()[0];
  expect(entry?.snapshot).toMatchObject({
    title: item.title,
    body: item.body,
    type: item.type,
    source_id: item.source_id,
  });
  const serialized = JSON.stringify(entry);
  expect(serialized).not.toContain(item.source_prompt);
  expect(serialized).not.toContain(item.command.script);
  expect(serialized).not.toContain(item.response);
  expect(serialized.length).toBeLessThan(2000);
});

test("should bound audit cleanup, honor retention overrides and leave newer records untouched", () => {
  const { sqlite, audit } = setup();
  const now = Date.UTC(2026, 6, 1);
  const ids = Array.from({ length: 4 }, () =>
    audit.record({ action: "memory.updated", subject_ids: ["historical-memory"] }),
  );
  for (const [index, id] of ids.entries())
    sqlite
      .query("UPDATE audit_log SET created_at=? WHERE id=?")
      .run(Math.floor((now - (index + 1) * DAY_MS) / 1000), id);
  expect(cleanupAuditLog(sqlite, 2, now, 2)).toBe(2);
  expect(audit.list()).toHaveLength(2);
  expect(cleanupAuditLog(sqlite, 2, now, 2)).toBe(1);
  expect(audit.list().map((event) => event.id)).toEqual([ids[0] ?? "missing"]);
  expect(cleanupAuditLog(sqlite, 90, now)).toBe(0);
  expect(audit.list()).toHaveLength(1);
});

test("should reject unbounded cleanup settings and retain existing audit provenance", () => {
  const { sqlite, audit } = setup();
  const id = audit.record({
    action: "skill.updated",
    actor: "codex",
    session_id: "original-session",
    subject_ids: ["original-skill"],
    snapshot: { previous_content: "Preserved rollback data" },
  });
  for (const days of [0, -1, 0.5, 3651, NaN, Infinity])
    expect(() => cleanupAuditLog(sqlite, days)).toThrow(RangeError);
  for (const batch of [0, -1, 1.5, 10001])
    expect(() => cleanupAuditLog(sqlite, 90, Date.now(), batch)).toThrow(RangeError);
  expect(() => cleanupAuditLog(sqlite, 90, NaN)).toThrow(RangeError);
  expect(audit.findLatest("original-skill", ["skill.updated"])).toMatchObject({
    id,
    actor: "codex",
    session_id: "original-session",
    snapshot: { previous_content: "Preserved rollback data" },
  });
});

test("should deduplicate across store reinitialization and record one expiry when queried repeatedly", () => {
  const { sqlite, notifications, audit, input, setNow } = setup();
  new NotificationStore(sqlite, () => input.created_at).publish(input);
  notifications.publish(input);
  setNow(input.expires_at);
  notifications.list();
  notifications.list();
  expect(audit.list({ entityType: "notification" })).toHaveLength(2);
});

test("should hide logically expired audit rows while bounded physical cleanup drains", () => {
  const { sqlite } = setup();
  const now = Date.UTC(2026, 6, 1);
  let retentionDays = 90;
  const audit = new AuditLog(sqlite, { now: () => now, retentionDays: () => retentionDays });
  const fresh = audit.record({ action: "task.created", subject_ids: ["fresh-task"] });
  const expired = audit.record({ action: "task.created", subject_ids: ["expired-task"] });
  const otherExpired = audit.record({
    action: "task.created",
    subject_ids: ["other-expired-task"],
  });
  sqlite
    .query("UPDATE audit_log SET created_at=? WHERE id IN (?,?)")
    .run(Math.floor((now - 90 * DAY_MS) / 1000), expired, otherExpired);
  expect(cleanupAuditLog(sqlite, 90, now, 1)).toBe(1);
  expect(sqlite.query("SELECT count(*) AS count FROM audit_log").get()).toEqual({ count: 2 });
  expect(audit.list({ since: 0 }).map((entry) => entry.id)).toEqual([fresh]);
  expect(audit.findLatest("expired-task", ["task.created"])).toBeNull();
  expect(audit.findLatest("other-expired-task", ["task.created"])).toBeNull();
  expect(audit.findLatest("fresh-task", ["task.created"])?.id).toBe(fresh);
  sqlite
    .query("UPDATE audit_log SET created_at=? WHERE id=?")
    .run(Math.floor((now - 2 * DAY_MS) / 1000), fresh);
  retentionDays = 1;
  expect(audit.list()).toEqual([]);
});

test("should bound snapshot previews in SQL without changing stored rollback data", () => {
  const { audit } = setup();
  const previousContent = "retained rollback content ".repeat(12000);
  audit.record({
    action: "skill.file_updated",
    subject_ids: ["large-skill"],
    snapshot: { previous_content: previousContent },
  });
  audit.record({
    action: "settings.retention_changed",
    subject_ids: [],
    snapshot: { before: 90, after: 120 },
  });
  const preview = audit.list({ entityType: "skill", snapshot: "preview" });
  expect(preview[0]?.snapshot).toMatchObject({ preview_truncated: true });
  expect(JSON.stringify(preview).length).toBeLessThan(1000);
  expect(audit.list({ entityType: "skill" })[0]?.snapshot).toEqual({
    previous_content: previousContent,
  });
  expect(audit.list({ entityType: "skill", snapshot: "full" })[0]?.snapshot).toEqual({
    previous_content: previousContent,
  });
  expect(audit.list({ entityType: "settings", snapshot: "preview" })[0]?.snapshot).toEqual({
    before: 90,
    after: 120,
  });
});

test("should remain writable from a reopened raw SQLite connection without registered functions", () => {
  const { sqlite } = setup();
  const legacyConnection = Database.deserialize(sqlite.serialize());
  databases.push(legacyConnection);
  expect(
    legacyConnection.query("SELECT name FROM sqlite_master WHERE type='trigger'").all(),
  ).toEqual([]);
  expect(() =>
    legacyConnection
      .query(`INSERT INTO notifications
    (id,source_key,type,source_id,title,body,level,path,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        "raw-writer",
        "legacy:one",
        "custom.event",
        "source",
        "Title",
        "",
        "done",
        "/",
        Date.now(),
        Date.now() + 1000,
      ),
  ).not.toThrow();
});

test("should record one bounded bulk read action rather than flooding audit per item", () => {
  const { notifications, audit, input } = setup();
  for (let index = 0; index < 20; index++)
    notifications.publish({ ...input, source_key: `batch:${index}`, source_id: `${index}` });
  notifications.markAllRead();
  notifications.markAllRead();
  const events = audit.list({ entityType: "notification", limit: 100 });
  expect(events.filter((entry) => entry.action === "notification.read_all")).toHaveLength(1);
  expect(events[0]?.snapshot).toEqual({ count: 20 });
  expect(events.filter((entry) => entry.action === "notification.read")).toEqual([]);
});

test("should roll back notification creation when its audit write fails", () => {
  const { sqlite, notifications, input } = setup();
  notifications.publish(input);
  sqlite.exec(
    "CREATE UNIQUE INDEX fixture_creation_audit_failure ON audit_log(action) WHERE action='notification.created'",
  );
  expect(() =>
    notifications.publish({ ...input, source_key: "another-event", source_id: "another-source" }),
  ).toThrow();
  expect(sqlite.query("SELECT count(*) AS count FROM notifications").get()).toEqual({ count: 1 });
  expect(sqlite.query("SELECT count(*) AS count FROM audit_log").get()).toEqual({ count: 1 });
});

test("should roll back read and expiry changes when the corresponding audit cannot be stored", () => {
  const readCase = setup();
  const first = readCase.notifications.publish(readCase.input);
  const second = readCase.notifications.publish({
    ...readCase.input,
    source_key: "second-read",
    source_id: "second",
  });
  if (!first || !second) throw new Error("Expected both notifications before expiry");
  readCase.sqlite.exec(
    "CREATE UNIQUE INDEX fixture_read_audit_failure ON audit_log(action) WHERE action='notification.read'",
  );
  readCase.notifications.update(first.id, { read: true });
  expect(() => readCase.notifications.update(second.id, { read: true })).toThrow();
  expect(
    readCase.notifications.list().notifications.find((item) => item.id === second.id)?.read_at,
  ).toBeNull();
  const expiryCase = setup();
  expiryCase.notifications.publish(expiryCase.input);
  expiryCase.notifications.publish({
    ...expiryCase.input,
    source_key: "second-expiry",
    source_id: "second",
  });
  expiryCase.sqlite.exec(
    "CREATE UNIQUE INDEX fixture_expiry_audit_failure ON audit_log(action) WHERE action='notification.expired'",
  );
  expiryCase.setNow(expiryCase.input.expires_at);
  expect(() => expiryCase.notifications.cleanup()).toThrow();
  expect(expiryCase.sqlite.query("SELECT count(*) AS count FROM notifications").get()).toEqual({
    count: 2,
  });
  expect(
    expiryCase.sqlite
      .query("SELECT count(*) AS count FROM audit_log WHERE action='notification.expired'")
      .get(),
  ).toEqual({ count: 0 });
});

test("should validate list bounds at the store boundary as well as the API", () => {
  const { notifications } = setup();
  for (const limit of [-1, 0, 101]) expect(() => notifications.list(limit)).toThrow();
  expect(() => notifications.list(50, -1)).toThrow();
  expect(() => notifications.list(50, 1000001)).toThrow();
});

test("should retry an audit primary ID collision without losing a distinct event", () => {
  const { sqlite, input } = setup();
  const options = { now: () => input.created_at, retentionDays: () => 90 };
  new AuditLog(sqlite, { ...options, generateId: () => "taken1" }).record({
    action: "task.created",
    subject_ids: ["first-task"],
  });
  const ids = ["taken1", "fresh1"];
  const audit = new AuditLog(sqlite, { ...options, generateId: () => ids.shift() ?? "fresh1" });
  expect(audit.record({ action: "task.created", subject_ids: ["second-task"] })).toBe("fresh1");
  expect(audit.list().map((event) => event.subject_ids[0])).toEqual(["second-task", "first-task"]);
});

test("should retry a notification primary ID collision without confusing source deduplication", () => {
  const { sqlite, input } = setup();
  const first = new NotificationStore(
    sqlite,
    () => input.created_at,
    () => 30,
    () => "taken2",
  ).publish(input);
  const ids = ["taken2", "fresh2"];
  let calls = 0;
  const store = new NotificationStore(
    sqlite,
    () => input.created_at,
    () => 30,
    () => {
      calls++;
      return ids.shift() ?? "taken2";
    },
  );
  const second = store.publish({ ...input, source_key: "distinct-event", source_id: "second" });
  expect(second?.id).toBe("fresh2");
  expect(store.list().notifications).toHaveLength(2);
  expect(store.publish(input)?.id).toBe(first?.id);
  expect(calls).toBe(2);
});

test("should bound generated primary ID retries when every candidate remains occupied", () => {
  const auditCase = setup();
  new AuditLog(auditCase.sqlite, { generateId: () => "taken3" }).record({
    action: "task.created",
    subject_ids: ["first"],
  });
  let auditCalls = 0;
  const audit = new AuditLog(auditCase.sqlite, {
    generateId: () => {
      auditCalls++;
      return "taken3";
    },
  });
  expect(() => audit.record({ action: "task.created", subject_ids: ["second"] })).toThrow();
  expect(auditCalls).toBe(8);
  expect(auditCase.sqlite.query("SELECT count(*) AS count FROM audit_log").get()).toEqual({
    count: 1,
  });
  const notificationCase = setup();
  new NotificationStore(
    notificationCase.sqlite,
    () => notificationCase.input.created_at,
    () => 30,
    () => "taken4",
  ).publish(notificationCase.input);
  let notificationCalls = 0;
  const store = new NotificationStore(
    notificationCase.sqlite,
    () => notificationCase.input.created_at,
    () => 30,
    () => {
      notificationCalls++;
      return "taken4";
    },
  );
  expect(() =>
    store.publish({ ...notificationCase.input, source_key: "second", source_id: "second" }),
  ).toThrow();
  expect(notificationCalls).toBe(8);
  expect(store.list().notifications).toHaveLength(1);
});

test("should not retry unrelated audit or notification constraint failures", () => {
  const auditCase = setup();
  auditCase.audit.record({ action: "task.created", subject_ids: ["first"] });
  auditCase.sqlite.exec(
    "CREATE UNIQUE INDEX fixture_unrelated_audit_constraint ON audit_log(action)",
  );
  let auditCalls = 0;
  const audit = new AuditLog(auditCase.sqlite, {
    generateId: () => {
      auditCalls++;
      return "fresh3";
    },
  });
  expect(() => audit.record({ action: "task.created", subject_ids: ["second"] })).toThrow();
  expect(auditCalls).toBe(1);
  const notificationCase = setup();
  notificationCase.notifications.publish(notificationCase.input);
  notificationCase.sqlite.exec(
    "CREATE UNIQUE INDEX fixture_unrelated_notification_constraint ON notifications(title)",
  );
  let notificationCalls = 0;
  const store = new NotificationStore(
    notificationCase.sqlite,
    () => notificationCase.input.created_at,
    () => 30,
    () => {
      notificationCalls++;
      return "fresh4";
    },
  );
  expect(() =>
    store.publish({ ...notificationCase.input, source_key: "second", source_id: "second" }),
  ).toThrow();
  expect(notificationCalls).toBe(1);
  expect(store.list().notifications).toHaveLength(1);
});

test("should trim the oldest rows beyond the size cap even when none have expired", () => {
  const { sqlite, audit } = setup();
  for (let index = 0; index < 5; index++)
    audit.record({ action: "job.created", subject_ids: [`job-${index}`] });
  expect(cleanupAuditLog(sqlite, 90, Date.UTC(2026, 0, 1), 10, 3)).toBe(2);
  expect(audit.list().map((entry) => entry.subject_ids[0])).toEqual(["job-4", "job-3", "job-2"]);
  expect(cleanupAuditLog(sqlite, 90, Date.UTC(2026, 0, 1), 10, 3)).toBe(0);
});
