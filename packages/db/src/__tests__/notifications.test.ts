import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { NotificationStore } from "../notifications.js";

const databases: Database[] = [];
function fixture() {
  let now = 1000;
  const db = new Database(":memory:");
  databases.push(db);
  const store = new NotificationStore(db, () => now);
  const input = {
    type: "custom.type",
    source_key: "producer:1",
    source_id: "1",
    title: "An update",
    level: "done" as const,
    path: "/jobs",
    created_at: 1000,
    expires_at: 2000,
  };
  return {
    db,
    store,
    input,
    advance: () => {
      now = 2000;
    },
  };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

test("should persist deduplicated extensible notifications and shared read/dismiss state", () => {
  const { db, store, input } = fixture();
  const first = store.publish(input);
  expect(first).not.toBeNull();
  expect(store.publish(input)?.id).toBe(first?.id);
  const secondClient = new NotificationStore(db, () => 1100);
  expect(secondClient.list().unread).toBe(1);
  const id = first?.id ?? "missing";
  secondClient.update(id, { read: true });
  expect(store.list().unread).toBe(0);
  expect(store.list().notifications).toHaveLength(1);
  store.update(id, { dismissed: true });
  expect(secondClient.list().notifications).toHaveLength(0);
  store.publish(input);
  expect(store.list().notifications).toHaveLength(0);
});

test("should expire and physically clean alerts without recreating old events", () => {
  const { db, store, input, advance } = fixture();
  store.publish({ ...input, requires_action: true });
  db.exec(
    "CREATE TABLE underlying_requests(id TEXT); INSERT INTO underlying_requests VALUES ('1');",
  );
  advance();
  expect(store.list()).toEqual({ notifications: [], unread: 0, has_more: false });
  expect(db.query("SELECT count(*) AS total FROM notifications").get()).toEqual({ total: 0 });
  expect(db.query("SELECT count(*) AS total FROM underlying_requests").get()).toEqual({ total: 1 });
  expect(store.publish(input)).toBeNull();
});

test("should reject invalid expiry, external links and empty updates", () => {
  const { store, input } = fixture();
  for (const path of ["//evil.test", "https://evil.test", "/\\evil", "/\nevil"])
    expect(() => store.publish({ ...input, path })).toThrow();
  expect(() => store.publish({ ...input, expires_at: 1000 })).toThrow();
  const item = store.publish(input);
  expect(() => store.update(item?.id ?? "missing", {})).toThrow();
});

test("should page history and resolve actions without changing read state", () => {
  const { store, input } = fixture();
  store.publish({ ...input, requires_action: true });
  store.publish({ ...input, source_key: "producer:2", source_id: "2", created_at: 1100 });
  expect(store.list(1).has_more).toBe(true);
  expect(store.list(1, 1).notifications[0]?.source_id).toBe("1");
  store.resolve(input.source_key);
  expect(store.list().notifications.find((item) => item.source_id === "1")?.requires_action).toBe(
    false,
  );
  expect(store.list().unread).toBe(2);
  store.markAllRead();
  expect(store.list(50, 0, true).notifications).toEqual([]);
});

test("should retire only the continuing session's completions, preserving history and audit", () => {
  const { db, store, input } = fixture();
  for (const [key, type, source] of [
    ["done:1", "agent.finished", "session"],
    ["other", "agent.finished", "other-session"],
    ["failure", "agent.failed", "session"],
    ["question", "agent.question", "session"],
    ["job", "job.finished", "session"],
  ] as const)
    store.publish({ ...input, source_key: key, type, source_id: source });
  expect(store.markFinishedRead("session")).toBe(1);
  expect(store.markFinishedRead("session")).toBe(0);
  expect(store.list().notifications).toHaveLength(5);
  expect(
    store
      .list(50, 0, true)
      .notifications.map((item) => item.type)
      .sort(),
  ).toEqual(["agent.failed", "agent.finished", "agent.question", "job.finished"]);
  expect(
    db.query("SELECT count(*) AS count FROM audit_log WHERE action='notification.read'").get(),
  ).toEqual({ count: 1 });
  const next = store.publish({
    ...input,
    source_key: "done:3",
    type: "agent.finished",
    source_id: "session",
    created_at: 1100,
  });
  expect(next?.read_at).toBeNull();
  expect(store.list(50, 0, true).unread).toBe(5);
});

test("should physically replace older finishes and ignore replay without restoring read or dismissed alerts", () => {
  const { db, store, input } = fixture();
  const first = store.publish({ ...input, type: "agent.finished" });
  const nextInput = {
    ...input,
    type: "agent.finished",
    source_key: "producer:next",
    created_at: 1100,
  };
  const next = store.publish(nextInput);
  expect(next).not.toBeNull();
  expect(db.query("SELECT count(*) AS count FROM notifications").get()).toEqual({ count: 1 });
  expect(
    db.query("SELECT id FROM notifications WHERE id=?").get(first?.id ?? "missing"),
  ).toBeNull();
  expect(store.publish({ ...input, type: "agent.finished" })).toBeNull();
  const id = next?.id ?? "missing";
  store.update(id, { read: true, dismissed: true });
  expect(store.publish(nextInput)?.id).toBe(id);
  expect(store.publish(nextInput)?.dismissed_at).not.toBeNull();
  expect(store.list().notifications).toHaveLength(0);
  expect(
    db
      .query("SELECT count(*) AS count FROM audit_log WHERE action='notification.superseded'")
      .get(),
  ).toEqual({ count: 1 });
});

test("should hide legacy duplicates immediately and physically drain them within the cleanup budget", () => {
  const { db, store, input } = fixture();
  const latest = store.publish({ ...input, type: "agent.finished", created_at: 1200 });
  if (!latest) throw new Error("Missing latest finish");
  const insert = db.query(`INSERT INTO notifications
    SELECT ?,?,type,source_id,title,body,level,project_id,path,requires_action,1000,expires_at,NULL,NULL
    FROM notifications WHERE id=?`);
  db.transaction(() => {
    for (let index = 0; index < 1005; index++)
      insert.run(`old-${index}`, `legacy:${index}`, latest.id);
  })();
  expect(store.cleanup(2)).toBe(2);
  expect(db.query("SELECT count(*) AS count FROM notifications").get()).toEqual({ count: 1004 });
  store.update(latest.id, { read: true });
  expect(store.list(50, 0, true)).toEqual({ notifications: [], unread: 0, has_more: false });
  expect(db.query("SELECT count(*) AS count FROM notifications").get()).toEqual({ count: 4 });
  expect(store.list().notifications.map((item) => item.id)).toEqual([latest.id]);
  expect(db.query("SELECT count(*) AS count FROM notifications").get()).toEqual({ count: 1 });
});

test("should preserve the previous finish if recording its replacement fails", () => {
  const { db, store, input } = fixture();
  const previous = store.publish({ ...input, type: "agent.finished" });
  if (!previous) throw new Error("Missing previous finish");
  db.exec(`CREATE TRIGGER reject_supersession BEFORE INSERT ON audit_log
    WHEN NEW.action='notification.superseded' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`);
  expect(() =>
    store.publish({
      ...input,
      type: "agent.finished",
      source_key: "replacement",
      created_at: 1100,
    }),
  ).toThrow("audit unavailable");
  expect(store.list().notifications.map((item) => item.id)).toEqual([previous.id]);
  expect(db.query("SELECT count(*) AS count FROM notifications").get()).toEqual({ count: 1 });
});
