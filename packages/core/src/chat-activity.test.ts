import { expect, test } from "bun:test";
import { appendChatActivity } from "./chat";

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
