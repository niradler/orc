import { expect, test } from "bun:test";
import { planEvent, planFromToolInput, planStatus } from "../plan.js";

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
