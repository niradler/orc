import { describe, expect, test } from "bun:test";
import {
  type AgentNotification,
  AgentNotifier,
  addNotifications,
  DEFAULT_NOTIFICATION_PREFS,
  MAX_TOASTS,
  type NotifySubject,
  notificationAnnouncement,
  notificationHeading,
  notificationLevel,
  parseNotificationPrefs,
  retireNotifications,
  SETTLE_MS,
  shouldPlaySound,
} from "../../src/lib/agent-notifications";
import type { AgentState } from "../../src/lib/agent-state";

const subject = (
  key: string,
  state: AgentState,
  extra: Partial<NotifySubject> = {},
): NotifySubject => ({
  key,
  state,
  title: `Session ${key}`,
  agent: "claude",
  projectId: null,
  target: { kind: "session", id: key },
  ...extra,
});
const never = () => false;

function notifierWith(...subjects: NotifySubject[]) {
  const notifier = new AgentNotifier();
  notifier.update(subjects, 0);
  return notifier;
}

describe("notificationLevel", () => {
  test("needs-you and failed ask for the user; done and working→idle are quiet", () => {
    expect(notificationLevel("working", "needs-you")).toBe("needs-you");
    expect(notificationLevel("working", "failed")).toBe("needs-you");
    expect(notificationLevel(undefined, "needs-you")).toBe("needs-you");
    expect(notificationLevel("working", "done")).toBe("done");
    expect(notificationLevel("working", "idle")).toBe("done");
    expect(notificationLevel("needs-you", "idle")).toBeNull();
    expect(notificationLevel("idle", "working")).toBeNull();
    expect(notificationLevel("done", "done")).toBeNull();
    expect(notificationLevel("working", null)).toBeNull();
  });
});

describe("AgentNotifier", () => {
  test("the first snapshot is a baseline, not a notification", () => {
    const notifier = new AgentNotifier();
    notifier.update([subject("a", "needs-you")], 0);
    expect(notifier.flush(5000, never)).toEqual([]);
  });

  test("a change notifies only after it has settled", () => {
    const notifier = notifierWith(subject("a", "working"));
    notifier.update([subject("a", "needs-you")], 100);
    expect(notifier.flush(100 + SETTLE_MS - 1, never)).toEqual([]);
    const [notification] = notifier.flush(100 + SETTLE_MS, never);
    expect(notification.level).toBe("needs-you");
    expect(notification.subjects.map((s) => s.key)).toEqual(["a"]);
  });

  test("flicker that reverts before settling never notifies", () => {
    const notifier = notifierWith(subject("a", "working"));
    notifier.update([subject("a", "needs-you")], 100);
    notifier.update([subject("a", "working")], 600);
    expect(notifier.flush(5000, never)).toEqual([]);
  });

  test("a changed target restarts the settle window", () => {
    const notifier = notifierWith(subject("a", "working"));
    notifier.update([subject("a", "idle")], 0);
    notifier.update([subject("a", "needs-you")], 900);
    expect(notifier.flush(1500, never)).toEqual([]);
    expect(notifier.flush(1900, never).map((n) => n.level)).toEqual(["needs-you"]);
  });

  test("one notification per state change, even across repeated snapshots", () => {
    const notifier = notifierWith(subject("a", "working"));
    notifier.update([subject("a", "done")], 0);
    notifier.update([subject("a", "done")], 500);
    expect(notifier.flush(1000, never)).toHaveLength(1);
    notifier.update([subject("a", "done")], 2000);
    expect(notifier.flush(4000, never)).toEqual([]);
    notifier.update([subject("a", "working")], 5000);
    notifier.update([subject("a", "done")], 5100);
    expect(notifier.flush(7000, never)).toEqual([]);
    notifier.update([subject("a", "working")], 8000);
    expect(notifier.flush(9000, never)).toEqual([]);
    notifier.update([subject("a", "done")], 10_000);
    expect(notifier.flush(11_000, never)).toHaveLength(1);
  });

  test("subjects in view are settled silently", () => {
    const notifier = notifierWith(subject("a", "working"), subject("b", "working"));
    notifier.update([subject("a", "needs-you"), subject("b", "needs-you")], 0);
    const [notification] = notifier.flush(SETTLE_MS, (s) => s.key === "a");
    expect(notification.subjects.map((s) => s.key)).toEqual(["b"]);
    expect(notifier.flush(10_000, never)).toEqual([]);
  });

  test("bursts collapse into one notification per level", () => {
    const notifier = notifierWith(
      subject("a", "working"),
      subject("b", "working"),
      subject("c", "working"),
      subject("d", "working"),
    );
    notifier.update(
      [subject("a", "done"), subject("b", "idle"), subject("c", "done"), subject("d", "needs-you")],
      0,
    );
    const notifications = notifier.flush(SETTLE_MS, never);
    expect(notifications.map((n) => [n.level, n.subjects.length])).toEqual([
      ["needs-you", 1],
      ["done", 3],
    ]);
    expect(notificationHeading(notifications[1])).toBe("3 sessions finished");
    expect(notifications[1].subjects.map((s) => s.state)).toEqual(["done", "done", "done"]);
  });

  test("a new subject that appears needing the user notifies; a vanished one is forgotten", () => {
    const notifier = notifierWith(subject("a", "working"));
    notifier.update([subject("a", "working"), subject("b", "needs-you")], 0);
    expect(notifier.flush(SETTLE_MS, never)[0].subjects[0].key).toBe("b");
    notifier.update([subject("a", "working")], 2000);
    expect(notifier.flush(4000, never)).toEqual([]);
    notifier.update([subject("a", "working"), subject("b", "needs-you")], 5000);
    expect(notifier.flush(7000, never)).toHaveLength(1);
  });
});

const toast = (id: string, level: AgentNotification["level"], ...subjects: NotifySubject[]) => ({
  id,
  level,
  subjects,
  createdAt: 0,
});

describe("toast stack", () => {
  test("refreshes approval actions when a request is replaced without changing session state", () => {
    const original = { ...subject("a", "needs-you"), approval: { id: "old", version: 1 } };
    const latest = { ...original, approval: { id: "new", version: 2 } };
    const result = retireNotifications(
      [toast("1", "needs-you", original)],
      new Map([["a", latest]]),
      never,
    );
    expect(result[0].subjects[0].approval).toEqual({ id: "new", version: 2 });
  });
  test("done toasts merge into one, needs-you toasts stack newest first", () => {
    let toasts = addNotifications([], [toast("1", "done", subject("a", "done"))]);
    toasts = addNotifications(toasts, [toast("2", "needs-you", subject("b", "needs-you"))]);
    toasts = addNotifications(toasts, [toast("3", "done", subject("c", "done"))]);
    expect(toasts.map((t) => t.id)).toEqual(["3", "2"]);
    expect(toasts[0].subjects.map((s) => s.key)).toEqual(["c", "a"]);
  });

  test("the stack is capped, dropping done toasts first", () => {
    let toasts = addNotifications([], [toast("done", "done", subject("x", "done"))]);
    for (let i = 0; i < MAX_TOASTS; i++)
      toasts = addNotifications(toasts, [
        toast(`n${i}`, "needs-you", subject(`${i}`, "needs-you")),
      ]);
    expect(toasts).toHaveLength(MAX_TOASTS);
    expect(toasts.some((t) => t.level === "done")).toBe(false);
  });

  test("needs-you toasts retire when the session is answered or comes into view", () => {
    const toasts = [
      toast("1", "needs-you", subject("a", "needs-you"), subject("b", "needs-you")),
      toast("2", "done", subject("c", "done")),
    ];
    const states = new Map([
      ["a", subject("a", "working")],
      ["b", subject("b", "needs-you")],
    ]);
    expect(retireNotifications(toasts, states, never).map((t) => t.subjects.length)).toEqual([
      1, 1,
    ]);
    expect(retireNotifications(toasts, states, (s) => s.key === "b").map((t) => t.id)).toEqual([
      "2",
    ]);
    const unchanged = new Map(toasts[0].subjects.map((subject) => [subject.key, subject]));
    expect(retireNotifications(toasts, unchanged, never)).toBe(toasts);
  });
});

describe("announcements and sound", () => {
  test("announcements name the state, agent and session", () => {
    const single = toast("1", "needs-you", subject("a", "needs-you"));
    expect(notificationAnnouncement(single)).toBe("Needs you: claude · Session a");
    const burst = toast("2", "needs-you", subject("a", "needs-you"), subject("b", "failed"));
    expect(notificationAnnouncement(burst)).toBe("2 sessions need you");
  });

  test("sound plays only for needs-you, respects volume, toggle and per-project mute", () => {
    const prefs = DEFAULT_NOTIFICATION_PREFS;
    const needsYou = toast("1", "needs-you", subject("a", "needs-you", { projectId: "p1" }));
    expect(shouldPlaySound(needsYou, prefs)).toBe(true);
    expect(shouldPlaySound(toast("2", "done", subject("a", "done")), prefs)).toBe(false);
    expect(shouldPlaySound(needsYou, { ...prefs, sound: false })).toBe(false);
    expect(shouldPlaySound(needsYou, { ...prefs, volume: 0 })).toBe(false);
    expect(shouldPlaySound(needsYou, { ...prefs, mutedProjects: ["p1"] })).toBe(false);
    const mixed = toast(
      "3",
      "needs-you",
      subject("a", "needs-you", { projectId: "p1" }),
      subject("b", "needs-you", { projectId: "p2" }),
    );
    expect(shouldPlaySound(mixed, { ...prefs, mutedProjects: ["p1"] })).toBe(true);
  });

  test("stored prefs are validated", () => {
    expect(parseNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs("not json")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs('{"sound":false,"volume":4,"mutedProjects":["p",3]}')).toEqual({
      sound: false,
      volume: 1,
      mutedProjects: ["p"],
    });
  });
});
