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
    ["done:2", "agent.finished", "session"],
    ["other", "agent.finished", "other-session"],
    ["failure", "agent.failed", "session"],
    ["question", "agent.question", "session"],
    ["job", "job.finished", "session"],
  ] as const)
    store.publish({ ...input, source_key: key, type, source_id: source });
  expect(store.markFinishedRead("session")).toBe(2);
  expect(store.markFinishedRead("session")).toBe(0);
  expect(store.list().notifications).toHaveLength(6);
  expect(
    store
      .list(50, 0, true)
      .notifications.map((item) => item.type)
      .sort(),
  ).toEqual(["agent.failed", "agent.finished", "agent.question", "job.finished"]);
  expect(
    db.query("SELECT count(*) AS count FROM audit_log WHERE action='notification.read'").get(),
  ).toEqual({ count: 2 });
  const next = store.publish({
    ...input,
    source_key: "done:3",
    type: "agent.finished",
    source_id: "session",
  });
  expect(next?.read_at).toBeNull();
  expect(store.list(50, 0, true).unread).toBe(5);
});
