import { expect, test } from "bun:test";
import type { ChatActivity } from "@orc/core/chat";
import {
  ACTIVITY_PREFS_KEY,
  type ActivityPrefs,
  activityCounts,
  activityPrefsJson,
  DEFAULT_ACTIVITY_PREFS,
  filterActivity,
  foldCounts,
  foldLabel,
  foldSummary,
  foldTurn,
  formatClock,
  formatDuration,
  parseActivityPrefs,
} from "../../src/lib/chat-activity";

const edit = (id: string, path: string, isError = false): ChatActivity => ({
  type: "tool",
  id,
  name: "Edit",
  input: JSON.stringify({ file_path: path, old_string: "a", new_string: "b" }),
  result: isError ? "denied" : "ok",
  isError,
});

const bash = (id: string, isError = false, result = "ok"): ChatActivity => ({
  type: "tool",
  id,
  name: "Bash",
  input: '{"command":"bun test"}',
  result,
  isError,
});

test("should fold a finished turn into duration, tool count, churn and unique changed files", () => {
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
    added: 3,
    removed: 3,
    commands: 1,
    durationMs: 42_000,
    current: null,
  });
  expect(foldLabel(fold)).toBe("Worked for 42s · 5 tools · 2 files changed (+3 −3) · 1 failed");
  expect(foldLabel(fold, true)).toBe("Working · 5 tools · 2 files changed (+3 −3) · 1 failed");
  expect(foldSummary(fold)).toEqual({
    text: "Worked for 42s · 5 tools · 2 files changed (+3 −3)",
    failure: "1 failed",
  });
  expect(foldCounts(fold, false)).toEqual(["5 tools", "2 files changed (+3 −3)"]);
});

test("should describe writes as changes and fall back to a command count", () => {
  const write: ChatActivity = {
    type: "tool",
    id: "w",
    name: "Write",
    input: JSON.stringify({ file_path: "docs/a.md", content: "one\ntwo" }),
    result: "Created",
  };
  const fold = foldTurn([write]);
  expect(fold).toMatchObject({ files: ["docs/a.md"], added: 2, removed: 0, commands: 0 });
  expect(foldLabel(fold)).toBe("Worked · 1 tool · 1 file changed (+2 −0)");

  expect(foldLabel(foldTurn([bash("c")]))).toBe("Worked · 1 tool · 1 command");
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

test("should count each activity filter without counting narration", () => {
  const items: ChatActivity[] = [
    { type: "thinking", id: "t", text: "Plan" },
    { type: "plan", id: "p", entries: [{ id: "1", status: "pending", content: "Step" }] },
    edit("edit", "src/a.ts"),
    bash("run-ok"),
    bash("run-failed", true, "error"),
    {
      type: "tool",
      id: "read",
      name: "Read",
      input: JSON.stringify({ file_path: "a.ts" }),
      result: "text",
    },
  ];
  expect(activityCounts(items)).toEqual({ all: 4, changes: 1, commands: 2, failed: 1 });
});

test("should filter tool calls while keeping narration, plans and every failure visible", () => {
  const items: ChatActivity[] = [
    { type: "thinking", id: "t", text: "Plan" },
    { type: "plan", id: "p", entries: [{ id: "1", status: "pending", content: "Step" }] },
    edit("edit", "src/a.ts"),
    bash("run", true, "error"),
  ];
  const prefs = (next: Partial<ActivityPrefs>): ActivityPrefs => ({
    ...DEFAULT_ACTIVITY_PREFS,
    ...next,
  });
  expect(filterActivity(items, prefs({}))).toHaveLength(4);
  expect(filterActivity(items, prefs({ filter: "changes" })).map((item) => item.id)).toEqual([
    "t",
    "p",
    "edit",
  ]);
  expect(filterActivity(items, prefs({ filter: "commands" })).map((item) => item.id)).toEqual([
    "t",
    "p",
    "run",
  ]);
  expect(filterActivity(items, prefs({ filter: "failed" })).map((item) => item.id)).toEqual([
    "t",
    "p",
    "run",
  ]);
  expect(filterActivity(items, prefs({ hideSuccessful: true })).map((item) => item.id)).toEqual([
    "t",
    "p",
    "run",
  ]);
});

test("should remember activity filter preferences tolerantly", () => {
  expect(parseActivityPrefs(null)).toEqual(DEFAULT_ACTIVITY_PREFS);
  expect(parseActivityPrefs("not json")).toEqual(DEFAULT_ACTIVITY_PREFS);
  expect(parseActivityPrefs('{"filter":"nope","hideSuccessful":true}')).toEqual({
    filter: "all",
    hideSuccessful: true,
  });
  const saved = parseActivityPrefs('{"filter":"commands","hideSuccessful":true}');
  expect(saved).toEqual({ filter: "commands", hideSuccessful: true });
  expect(ACTIVITY_PREFS_KEY).toBe("orc_chat_activity_prefs");
  expect(ACTIVITY_PREFS_KEY.startsWith("orc_chat_")).toBe(true);
  expect(activityPrefsJson(saved)).toBe('{"filter":"commands","hideSuccessful":true}');
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
