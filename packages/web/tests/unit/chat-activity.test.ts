import { expect, test } from "bun:test";
import type { ChatActivity } from "@orc/core/chat";
import { foldLabel, foldTurn, formatClock, formatDuration } from "../../src/lib/chat-activity";

const edit = (id: string, path: string, isError = false): ChatActivity => ({
  type: "tool",
  id,
  name: "Edit",
  input: JSON.stringify({ file_path: path, old_string: "a", new_string: "b" }),
  result: isError ? "denied" : "ok",
  isError,
});

test("should fold a finished turn into duration, tool count and unique changed files", () => {
  const items: ChatActivity[] = [
    { type: "thinking", id: "t", text: "Plan" },
    edit("a", "src/a.ts"),
    edit("b", "src/a.ts"),
    edit("c", "src/b.ts"),
    edit("d", "src/denied.ts", true),
    { type: "status", id: "s", text: "Compacting" },
    { type: "tool", id: "e", name: "Bash", input: '{"command":"ls"}', result: "x" },
  ];
  const fold = foldTurn(items, { startedAt: 1_000, finishedAt: 43_000 });
  expect(fold).toEqual({
    tools: 5,
    thoughts: 1,
    failed: 1,
    running: 0,
    files: ["src/a.ts", "src/b.ts"],
    durationMs: 42_000,
    current: null,
  });
  expect(foldLabel(fold)).toBe("Worked for 42s · 5 tools · 2 files changed");
  expect(foldLabel(fold, true)).toBe("Working · 5 tools · 2 files changed");
});

test("should leave duration unknown when timing is missing or the turn ended instantly", () => {
  const tool: ChatActivity = { type: "tool", id: "a", name: "Read", input: "{}", result: "" };
  expect(foldTurn([tool]).durationMs).toBeNull();
  expect(foldTurn([tool], { startedAt: 5_000, finishedAt: 5_000 }).durationMs).toBeNull();
  expect(foldLabel(foldTurn([tool]))).toBe("Worked · 1 tool");
  expect(foldLabel(foldTurn([{ type: "thinking", id: "t", text: "x" }]))).toBe(
    "Worked · 1 thought",
  );
});

test("should expose the latest unfinished tool as the current one", () => {
  const fold = foldTurn([
    { type: "tool", id: "a", name: "Read", input: "{}" },
    { type: "tool", id: "b", name: "Bash", input: "{}", result: "done" },
    { type: "tool", id: "c", name: "Grep", input: "{}" },
  ]);
  expect(fold.running).toBe(2);
  expect(fold.current?.id).toBe("c");
});

test("should prefer native duration and distinguish stopped and failed turns", () => {
  const fold = foldTurn([], { startedAt: 0, finishedAt: 90_000, durationMs: 42_000 });
  expect(fold.durationMs).toBe(42_000);
  expect(foldLabel(fold, false, "stopped")).toBe("Stopped after 42s");
  expect(foldLabel(fold, false, "failed")).toBe("Failed after 42s");
  expect(foldTurn([], { startedAt: 0, finishedAt: 2_000 }).durationMs).toBe(2_000);
});

test("should format durations and live clocks", () => {
  expect(formatDuration(999)).toBe("0s");
  expect(formatDuration(42_400)).toBe("42s");
  expect(formatDuration(60_000)).toBe("1m");
  expect(formatDuration(65_000)).toBe("1m 5s");
  expect(formatDuration(3_720_000)).toBe("1h 2m");
  expect(formatDuration(7_200_000)).toBe("2h");
  expect(formatClock(18_900)).toBe("0:18");
  expect(formatClock(62_000)).toBe("1:02");
  expect(formatClock(3_723_000)).toBe("1:02:03");
  expect(formatClock(-5)).toBe("0:00");
});
