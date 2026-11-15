import { expect, test } from "bun:test";
import {
  appendChatActivity,
  buildChatItems,
  CHAT_ITEM_WINDOW,
  type ChatActivity,
  type ChatProviderActivity,
} from "./chat";

test("should update a re-announced tool call in place and keep its result", () => {
  let activity = appendChatActivity([], {
    type: "tool_use",
    data: { id: "t", name: "MCP: tool", input: "" },
  });
  activity = appendChatActivity(activity, {
    type: "tool_result",
    data: { toolUseId: "t", content: "done", isError: false },
  });
  activity = appendChatActivity(activity, {
    type: "tool_use",
    data: { id: "t", name: "orc: tool_search", input: "{}" },
  });
  expect(activity).toEqual([
    {
      type: "tool",
      id: "t",
      name: "orc: tool_search",
      input: "{}",
      result: "done",
      isError: false,
      startedAt: expect.any(Number),
    },
  ]);
});

test("should keep one start time when a call is re-announced", () => {
  let activity = appendChatActivity([], {
    type: "tool_use",
    data: { id: "t", name: "Bash", input: '{"command":"bun test"}' },
  });
  const startedAt = (activity[0] as { startedAt?: number }).startedAt;
  activity = appendChatActivity(activity, {
    type: "tool_use",
    data: { id: "t", name: "Bash", input: '{"command":"bun test"}' },
  });
  expect((activity[0] as { startedAt?: number }).startedAt).toBe(startedAt);
});

test("should mark a detached command and a background subagent", () => {
  const command = appendChatActivity([], {
    type: "tool_use",
    data: { id: "c", name: "Bash", input: '{"command":"bun dev","run_in_background":true}' },
  });
  const subagent = appendChatActivity([], {
    type: "tool_use",
    data: { id: "s", name: "Task", input: '{"prompt":"review","runInBackground":true}' },
  });
  expect(command[0]).toMatchObject({ type: "tool", background: "command" });
  expect(subagent[0]).toMatchObject({ type: "tool", background: "subagent" });
});

test("should not mark a call that declared no background work or cannot be parsed", () => {
  const foreground = appendChatActivity([], {
    type: "tool_use",
    data: { id: "c", name: "Bash", input: '{"command":"bun test"}' },
  });
  const unparsable = appendChatActivity([], {
    type: "tool_use",
    data: { id: "d", name: "Bash", input: "bun test" },
  });
  expect(foreground[0]).not.toHaveProperty("background");
  expect(unparsable[0]).not.toHaveProperty("background");
});

test("should keep known activity order, ids and ordinals", () => {
  const activity: ChatActivity[] = [
    { type: "thinking", id: "think", text: "Plan" },
    { type: "tool", id: "edit", name: "Edit", input: '{"file_path":"a.ts"}', result: "Updated" },
    { type: "status", id: "note", text: "Compacting" },
    {
      type: "plan",
      id: "plan",
      title: "Refactor",
      entries: [{ id: "1", status: "in_progress", content: "Move the fold" }],
    },
  ];
  expect(buildChatItems({ activity })).toEqual([
    { id: "think", ordinal: 0, kind: "thinking", text: "Plan" },
    {
      id: "edit",
      ordinal: 1,
      kind: "tool",
      name: "Edit",
      input: '{"file_path":"a.ts"}',
      result: "Updated",
    },
    { id: "note", ordinal: 2, kind: "status", text: "Compacting" },
    {
      id: "plan",
      ordinal: 3,
      kind: "plan",
      title: "Refactor",
      entries: [{ id: "1", status: "in_progress", content: "Move the fold" }],
    },
  ]);
});

test("should append provider activities after the known ones and keep their data", () => {
  const providerActivity: ChatProviderActivity[] = [
    { id: "unknown-1", kind: "checkpoint", data: { type: "checkpoint", parentId: "edit" } },
    { id: "unknown-2", kind: "artifact" },
  ];
  const items = buildChatItems({
    activity: [
      { type: "tool", id: "edit", name: "Edit", input: "{}", result: "Updated" },
      { type: "status", id: "note", text: "Done" },
    ],
    providerActivity,
  });
  expect(items.map((item) => [item.id, item.ordinal, item.kind])).toEqual([
    ["edit", 0, "tool"],
    ["note", 1, "status"],
    ["unknown-1", 2, "provider"],
    ["unknown-2", 3, "provider"],
  ]);
  expect(items[2]).toMatchObject({
    kind: "provider",
    provider: "checkpoint",
    data: { type: "checkpoint", parentId: "edit" },
  });
  expect(items[3]).toMatchObject({ kind: "provider", provider: "artifact" });
  expect(items[3]).not.toHaveProperty("data");
});

test("should nest a provider activity only under a tool its data names", () => {
  const items = buildChatItems({
    activity: [{ type: "tool", id: "tool-1", name: "Bash", input: "{}", result: "ok" }],
    providerActivity: [
      { id: "child", kind: "progress", data: { parentId: "tool-1" } },
      { id: "belongs", kind: "progress", data: { toolUseId: "tool-1" } },
      { id: "unknown-parent", kind: "progress", data: { parentId: "missing" } },
      { id: "no-parent", kind: "progress", data: { value: 1 } },
    ],
  });
  expect(items[1]).toMatchObject({ id: "child", kind: "provider", parentId: "tool-1" });
  expect(items[2]).toMatchObject({ id: "belongs", kind: "provider", parentId: "tool-1" });
  expect(items[3]).toMatchObject({ id: "unknown-parent", kind: "provider" });
  expect(items[3]).not.toHaveProperty("parentId");
  expect(items[4]).toMatchObject({ id: "no-parent", kind: "provider" });
  expect(items[4]).not.toHaveProperty("parentId");
});

test("should mark only a failed tool with a status", () => {
  const items = buildChatItems({
    activity: [
      { type: "tool", id: "ok", name: "Read", input: "{}", result: "text" },
      { type: "tool", id: "bad", name: "Bash", input: "{}", result: "denied", isError: true },
      { type: "plan", id: "plan", entries: [{ id: "1", status: "failed", content: "Step" }] },
      { type: "thinking", id: "think", text: "Plan" },
    ],
  });
  expect(items[0]).toMatchObject({ id: "ok", kind: "tool" });
  expect(items[0]).not.toHaveProperty("status");
  expect(items[1]).toMatchObject({ id: "bad", kind: "tool", status: "failed" });
  expect(items[2]).toMatchObject({ id: "plan", kind: "plan" });
  expect(items[2]).not.toHaveProperty("status");
  expect(items[3]).not.toHaveProperty("status");
});

test("should return no items for empty or missing activity", () => {
  expect(buildChatItems({})).toEqual([]);
  expect(buildChatItems({ activity: [], providerActivity: [] })).toEqual([]);
  expect(CHAT_ITEM_WINDOW).toBe(80);
});
