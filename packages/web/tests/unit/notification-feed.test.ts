import { expect, test } from "bun:test";
import type { OrcNotification } from "@orc/core/notifications";
import { mergeNotificationToasts, NotificationFeed } from "../../src/lib/notification-feed";

const item = (id: string, type = "future.type"): OrcNotification => ({
  id,
  type,
  source_id: id,
  title: id,
  body: "",
  level: "needs-you",
  project_id: null,
  path: "/activity",
  requires_action: true,
  created_at: 1000,
  expires_at: 10000,
  read_at: null,
  dismissed_at: null,
});
test("should settle new generic types once and never replay initial history", () => {
  const feed = new NotificationFeed();
  feed.update([item("old")], 1000);
  expect(feed.flush(3000, () => false)).toEqual([]);
  feed.update([item("new"), item("old")], 3000);
  expect(feed.flush(3999, () => false)).toEqual([]);
  expect(feed.flush(4000, () => false).map((item) => item.id)).toEqual(["new"]);
  feed.update([item("new"), item("old")], 5000);
  expect(feed.flush(6000, () => false)).toEqual([]);
});
test("should recheck resolved, dismissed, expired and viewed alerts before delivery", () => {
  const feed = new NotificationFeed();
  feed.update([], 0);
  feed.update(
    [
      item("resolved"),
      item("dismissed"),
      item("expired"),
      item("viewed"),
      item("job", "job.failed"),
    ],
    1000,
  );
  feed.update(
    [
      { ...item("resolved"), requires_action: false },
      { ...item("dismissed"), dismissed_at: 1500 },
      { ...item("expired"), expires_at: 1900 },
      item("viewed"),
      item("job", "job.failed"),
    ],
    1500,
  );
  expect(feed.flush(2000, (item) => item.id === "viewed").map((item) => item.id)).toEqual(["job"]);
});

test("should collapse mixed completion bursts while keeping urgent notices separate", () => {
  const result = mergeNotificationToasts(
    [],
    [
      item("needs"),
      { ...item("job", "job.finished"), level: "done" },
      { ...item("agent", "agent.finished"), level: "done" },
    ],
  );
  expect(result).toHaveLength(2);
  expect(result[1]?.items.map((item) => item.type)).toEqual(["job.finished", "agent.finished"]);
  const next = mergeNotificationToasts(result, [
    { ...item("another", "future.completed"), level: "done" },
  ]);
  expect(next[1]?.items).toHaveLength(3);
});
