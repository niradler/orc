import { describe, expect, test } from "bun:test";
import { isJumpShortcut, nextJump, STATE_FILTER_COMMANDS } from "../../src/lib/command-palette";
import { filterCounts, matchesFilter, parseFilter } from "../../src/lib/session-filter";
import { lastSeen, parseSeen, unseenState, withSeen } from "../../src/lib/session-seen";
import { stableOrder } from "../../src/lib/stable-order";

describe("session seen record", () => {
  test("should start a fresh baseline when storage is empty or corrupt", () => {
    expect(parseSeen(null, 5)).toEqual({ since: 5, seen: {} });
    expect(parseSeen("{not json", 7)).toEqual({ since: 7, seen: {} });
    expect(parseSeen(JSON.stringify({ since: "x", seen: {} }), 9)).toEqual({ since: 9, seen: {} });
  });

  test("should keep valid entries and drop malformed ones", () => {
    const raw = JSON.stringify({ since: 1, seen: { a: 10, b: "late", c: null } });
    expect(parseSeen(raw, 99)).toEqual({ since: 1, seen: { a: 10 } });
  });

  test("should use the latest of the baseline and every alias key", () => {
    const record = { since: 100, seen: { "chat:1": 150, "native:9": 300 } };
    expect(lastSeen(record, ["chat:1", "native:9"])).toBe(300);
    expect(lastSeen(record, ["chat:2"])).toBe(100);
  });

  test("should only move seen times forward and return the same record when nothing changes", () => {
    const record = { since: 0, seen: { a: 50 } };
    expect(withSeen(record, ["a"], 40)).toBe(record);
    expect(withSeen(record, ["a", "b"], 60)).toEqual({ since: 0, seen: { a: 60, b: 60 } });
    expect(record.seen).toEqual({ a: 50 });
  });

  test("should prune to the most recently seen sessions", () => {
    const seen = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`s${i}`, i]));
    const next = withSeen({ since: 0, seen }, ["new"], 5000);
    expect(Object.keys(next.seen)).toHaveLength(2000);
    expect(next.seen.new).toBe(5000);
    expect(next.seen.s0).toBeUndefined();
  });

  test("should show Done only for finished activity after the last view", () => {
    expect(unseenState("idle", 200, 100)).toBe("done");
    expect(unseenState("ended", 200, 100)).toBe("done");
    expect(unseenState("idle", 100, 200)).toBe("idle");
    expect(unseenState("working", 200, 100)).toBe("working");
    expect(unseenState("needs-you", 200, 100)).toBe("needs-you");
    expect(unseenState("failed", 200, 100)).toBe("failed");
  });
});

describe("session state filters", () => {
  test("should count failures with Needs you over one flat list", () => {
    expect(filterCounts(["needs-you", "failed", "working", "done", "idle", "ended"])).toEqual({
      all: 6,
      "needs-you": 2,
      working: 1,
      done: 1,
    });
    expect(matchesFilter("failed", "needs-you")).toBe(true);
    expect(matchesFilter("idle", "done")).toBe(false);
    expect(matchesFilter("ended", "all")).toBe(true);
  });

  test("should fall back to All for unknown values", () => {
    expect(parseFilter("working")).toBe("working");
    expect(parseFilter("bogus")).toBe("all");
    expect(parseFilter(null)).toBe("all");
  });
});

describe("stable order", () => {
  const rows = (...ids: string[]) => ids.map((id) => ({ id, version: "1" }));

  test("should report nothing pending when the live order matches", () => {
    expect(stableOrder(rows("a", "b"), rows("a", "b"), () => true)).toEqual({
      order: ["a", "b"],
      pending: 0,
    });
  });

  test("should hold the snapshot order and count moved and new rows", () => {
    const live = [{ id: "c", version: "1" }, { id: "b", version: "2" }, ...rows("a")];
    expect(stableOrder(rows("a", "b"), live, () => true)).toEqual({
      order: ["a", "b"],
      pending: 2,
    });
  });

  test("should drop rows that no longer exist and count rows that left the live list", () => {
    expect(stableOrder(rows("a", "b", "c"), rows("a", "c"), (id) => id !== "b")).toEqual({
      order: ["a", "c"],
      pending: 0,
    });
    expect(stableOrder(rows("a", "b"), rows("a"), () => true)).toEqual({
      order: ["a", "b"],
      pending: 1,
    });
  });

  test("should count a pure reorder as at least one update", () => {
    expect(stableOrder(rows("a", "b"), rows("b", "a"), () => true).pending).toBe(1);
  });
});

describe("session jump", () => {
  const targets = [
    { id: "done-old", state: "done" as const, at: 1 },
    { id: "needs-old", state: "needs-you" as const, at: 2 },
    { id: "working", state: "working" as const, at: 9 },
    { id: "failed", state: "failed" as const, at: 3 },
    { id: "done-new", state: "done" as const, at: 8 },
    { id: "idle", state: "idle" as const, at: 10 },
  ];

  test("should visit sessions that need you, then unseen Done, newest first", () => {
    const visited = new Set<string>();
    const order: (string | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      const id = nextJump(targets, visited)?.id;
      if (id) visited.add(id);
      order.push(id);
    }
    expect(order).toEqual(["failed", "needs-old", "done-new", "done-old"]);
    expect(nextJump(targets, visited)?.id).toBe("failed");
  });

  test("should move on when a visited Done session drops out once seen", () => {
    const remaining = targets.filter((target) => target.id !== "done-new");
    expect(nextJump(remaining, new Set(["failed", "needs-old", "done-new"]))?.id).toBe("done-old");
  });

  test("should restrict to one kind and return nothing when no session qualifies", () => {
    expect(nextJump(targets, new Set(), "done")?.id).toBe("done-new");
    expect(nextJump(targets, new Set(["failed"]), "needs-you")?.id).toBe("needs-old");
    expect(nextJump([{ id: "x", state: "idle", at: 1 }], new Set())).toBeUndefined();
  });

  test("should bind Alt+J only without other modifiers", () => {
    const key = { code: "KeyJ", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(isJumpShortcut(key)).toBe(true);
    expect(isJumpShortcut({ ...key, ctrlKey: true })).toBe(false);
    expect(isJumpShortcut({ ...key, altKey: false })).toBe(false);
    expect(isJumpShortcut({ ...key, code: "KeyK" })).toBe(false);
  });

  test("should offer a palette command per state filter", () => {
    expect(STATE_FILTER_COMMANDS.map((command) => command.path)).toEqual([
      "/sessions",
      "/sessions?state=needs-you",
      "/sessions?state=working",
      "/sessions?state=done",
    ]);
  });
});
