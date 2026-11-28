import { expect, test } from "bun:test";
import { PlanTracker, planEvent, planFromToolInput, planStatus } from "../plan.js";

test("should map ACP plan entries to one plan activity", () => {
  expect(
    planEvent("plan", [
      { content: "Read the code", status: "in_progress" },
      { content: "Change it", status: "pending" },
      { content: "Verify", status: "completed" },
    ]),
  ).toEqual({
    type: "plan",
    data: {
      id: "plan",
      entries: [
        { id: "0", status: "in_progress", content: "Read the code" },
        { id: "1", status: "pending", content: "Change it" },
        { id: "2", status: "completed", content: "Verify" },
      ],
    },
  });
});

test("should normalize provider status spellings and skip unnamed entries", () => {
  expect(planStatus("inProgress")).toBe("in_progress");
  expect(planStatus("completed")).toBe("completed");
  expect(planStatus("cancelled")).toBe("failed");
  expect(planStatus(undefined)).toBe("pending");
  const event = planEvent("plan", [
    { content: "", status: "pending" },
    { content: "Real step", status: "inProgress" },
  ]);
  expect(event).toMatchObject({ data: { entries: [{ id: "1", status: "in_progress" }] } });
});

test("should emit nothing when a provider has no plan", () => {
  expect(planEvent("plan", [])).toBeNull();
  expect(planEvent("plan", [{ content: "   ", status: "pending" }])).toBeNull();
  expect(planFromToolInput("read", '{"path":"a.ts"}')).toBeNull();
  expect(planFromToolInput("TodoWrite", "not json")).toBeNull();
  expect(planFromToolInput("TodoWrite", '{"items":[]}')).toBeNull();
});

test("should read Claude's TodoWrite and OpenCode's todo tool as the same plan", () => {
  const claude = planFromToolInput(
    "TodoWrite",
    JSON.stringify({
      todos: [
        { content: "Inspect the header", status: "completed", activeForm: "Inspecting" },
        { content: "Add the strip", status: "in_progress", activeForm: "Adding" },
      ],
    }),
  );
  expect(claude).toEqual({
    type: "plan",
    data: {
      id: "todos",
      entries: [
        { id: "0", status: "completed", content: "Inspect the header" },
        { id: "1", status: "in_progress", content: "Add the strip" },
      ],
    },
  });
  const opencode = planFromToolInput(
    "opencode: todowrite",
    JSON.stringify({ todos: [{ id: "t1", content: "Add the strip", status: "in_progress" }] }),
  );
  expect(opencode).toMatchObject({
    data: { id: "todos", entries: [{ id: "t1", status: "in_progress" }] },
  });
});

test("should ignore a tool whose name merely contains todo", () => {
  expect(
    planFromToolInput(
      "todoist_search",
      JSON.stringify({ todos: [{ content: "x", status: "pending" }] }),
    ),
  ).toBeNull();
});

function entries(event: ReturnType<PlanTracker["observeToolResult"]>) {
  return (event?.data as { entries?: unknown } | undefined)?.entries;
}

test("should build Claude's task checklist from TaskCreate and TaskUpdate results", () => {
  const plan = new PlanTracker();
  plan.observeToolUse("call-1", "TaskCreate", {
    subject: "Alpha",
    description: "Do alpha",
    activeForm: "Doing alpha",
  });
  // The task id exists only in the result, so nothing renders before it.
  expect(
    entries(plan.observeToolResult("call-1", { task: { id: "1", subject: "Alpha" } })),
  ).toEqual([{ id: "1", status: "pending", content: "Alpha" }]);

  plan.observeToolUse("call-2", "TaskUpdate", { taskId: "1", status: "in_progress" });
  expect(
    entries(
      plan.observeToolResult("call-2", {
        success: true,
        taskId: "1",
        updatedFields: ["status"],
        statusChange: { from: "pending", to: "in_progress" },
      }),
    ),
  ).toEqual([{ id: "1", status: "in_progress", content: "Alpha" }]);

  plan.observeToolUse("call-3", "TaskUpdate", { taskId: "1", status: "completed" });
  expect(entries(plan.observeToolResult("call-3", { success: true, taskId: "1" }))).toEqual([
    { id: "1", status: "completed", content: "Alpha" },
  ]);
});

test("should keep a task's status when TaskUpdate renames it", () => {
  const plan = new PlanTracker();
  plan.observeToolUse("a", "TaskCreate", { subject: "Original" });
  plan.observeToolResult("a", { task: { id: "1", subject: "Original" } });
  plan.observeToolUse("b", "TaskUpdate", { taskId: "1", status: "completed" });
  plan.observeToolResult("b", { success: true, taskId: "1" });
  plan.observeToolUse("c", "TaskUpdate", { taskId: "1", subject: "Renamed" });
  expect(entries(plan.observeToolResult("c", { success: true, taskId: "1" }))).toEqual([
    { id: "1", status: "completed", content: "Renamed" },
  ]);
});

test("should drop a deleted task from later snapshots", () => {
  const plan = new PlanTracker();
  plan.observeToolUse("a", "TaskCreate", { subject: "Keep" });
  plan.observeToolResult("a", { task: { id: "1", subject: "Keep" } });
  plan.observeToolUse("b", "TaskCreate", { subject: "Drop" });
  plan.observeToolResult("b", { task: { id: "2", subject: "Drop" } });
  plan.observeToolUse("c", "TaskUpdate", { taskId: "2", status: "deleted" });
  expect(entries(plan.observeToolResult("c", { success: true, taskId: "2" }))).toEqual([
    { id: "1", status: "pending", content: "Keep" },
  ]);
});

test("should replace the checklist from a TaskList result", () => {
  const plan = new PlanTracker();
  plan.observeToolUse("a", "TaskCreate", { subject: "Stale" });
  plan.observeToolResult("a", { task: { id: "9", subject: "Stale" } });
  plan.observeToolUse("b", "TaskList", {});
  expect(
    entries(
      plan.observeToolResult("b", {
        tasks: [
          { id: "1", subject: "Alpha", status: "completed", blockedBy: [] },
          { id: "2", subject: "Beta", status: "in_progress", blockedBy: ["1"] },
        ],
      }),
    ),
  ).toEqual([
    { id: "1", status: "completed", content: "Alpha" },
    { id: "2", status: "in_progress", content: "Beta" },
  ]);
});

test("should ignore failed, duplicate and unrelated task tool results", () => {
  const plan = new PlanTracker();
  plan.observeToolUse("a", "TaskCreate", { subject: "Alpha" });
  // A duplicate result id applies once.
  expect(
    entries(plan.observeToolResult("a", { task: { id: "1", subject: "Alpha" } })),
  ).toHaveLength(1);
  expect(plan.observeToolResult("a", { task: { id: "2", subject: "Other" } })).toBeNull();

  plan.observeToolUse("b", "TaskUpdate", { taskId: "1", status: "completed" });
  expect(plan.observeToolResult("b", { success: false, error: "nope" })).toBeNull();

  plan.observeToolUse("c", "TaskUpdate", { taskId: "1", status: "completed" });
  expect(plan.observeToolResult("c", { success: true, taskId: "1" }, true)).toBeNull();

  plan.observeToolUse("d", "Read", { path: "a.ts" });
  expect(plan.observeToolResult("d", { content: "x" })).toBeNull();
  expect(plan.observeToolResult("missing", { task: { id: "3", subject: "x" } })).toBeNull();
});

test("should reset between turns and normalize a prefixed tool name", () => {
  const plan = new PlanTracker();
  plan.observeToolUse("a", "mcp__server__TaskCreate", { subject: "Alpha" });
  expect(
    entries(plan.observeToolResult("a", { task: { id: "1", subject: "Alpha" } })),
  ).toHaveLength(1);
  plan.reset();
  expect(
    entries(plan.observeToolResult("a", { task: { id: "1", subject: "Alpha" } })),
  ).toBeUndefined();
});
