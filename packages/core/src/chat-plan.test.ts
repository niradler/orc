import { expect, test } from "bun:test";
import { appendChatActivity, CHAT_PLAN_MAX_ENTRIES, type ChatPlanPayload } from "./chat";

const plan = (entries: ChatPlanPayload["entries"], title?: string): ChatPlanPayload => ({
  id: "plan",
  ...(title ? { title } : {}),
  entries,
});

test("should append a plan and update its entries in place on the next snapshot", () => {
  let activity = appendChatActivity([], {
    type: "plan",
    data: plan([
      { id: "0", status: "in_progress", content: "Map adapters" },
      { id: "1", status: "pending", content: "Ship card" },
    ]),
  });
  activity = appendChatActivity(activity, {
    type: "plan",
    data: plan([
      { id: "0", status: "completed", content: "Map adapters" },
      { id: "1", status: "in_progress", content: "Ship card" },
    ]),
  });
  expect(activity).toEqual([
    {
      type: "plan",
      id: "plan",
      entries: [
        { id: "0", status: "completed", content: "Map adapters" },
        { id: "1", status: "in_progress", content: "Ship card" },
      ],
    },
  ]);
});

test("should not re-render or duplicate on a repeated identical plan snapshot", () => {
  const first = appendChatActivity([], {
    type: "plan",
    data: plan([{ id: "0", status: "pending", content: "Read the code" }], "Plan"),
  });
  const second = appendChatActivity(first, {
    type: "plan",
    data: plan([{ id: "0", status: "pending", content: "Read the code" }], "Plan"),
  });
  // Same reference: the transcript did not change, so React does not re-render.
  expect(second).toBe(first);
});

test("should collapse status flapping into one entry per id", () => {
  let activity = appendChatActivity([], {
    type: "plan",
    data: plan([{ id: "step", status: "pending", content: "Wire the header" }]),
  });
  for (const status of ["in_progress", "pending", "in_progress", "completed"] as const)
    activity = appendChatActivity(activity, {
      type: "plan",
      data: plan([{ id: "step", status, content: "Wire the header" }]),
    });
  const items = activity.filter((item) => item.type === "plan");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    entries: [{ id: "step", status: "completed", content: "Wire the header" }],
  });
});

test("should keep entries the newer snapshot omits and start a new block for a new plan id", () => {
  let activity = appendChatActivity([], {
    type: "plan",
    data: plan([{ id: "0", status: "completed", content: "First" }]),
  });
  activity = appendChatActivity(activity, {
    type: "plan",
    data: plan([{ id: "0", status: "completed", content: "First is longer" }]),
  });
  expect(activity[0]).toMatchObject({ entries: [{ content: "First is longer" }] });
  activity = appendChatActivity(activity, {
    type: "plan",
    data: { id: "second-plan", entries: [{ id: "0", status: "pending", content: "Next" }] },
  });
  expect(activity.map((item) => item.id)).toEqual(["plan", "second-plan"]);
});

test("should cap plan entries so a runaway checklist stays bounded", () => {
  const entries = Array.from({ length: CHAT_PLAN_MAX_ENTRIES + 10 }, (_, index) => ({
    id: String(index),
    status: "pending" as const,
    content: `Step ${index}`,
  }));
  const activity = appendChatActivity([], { type: "plan", data: plan(entries) });
  expect(activity[0]).toMatchObject({ type: "plan" });
  const planItem = activity[0];
  if (planItem?.type !== "plan") throw new Error("No plan stored");
  expect(planItem.entries).toHaveLength(CHAT_PLAN_MAX_ENTRIES);
});
