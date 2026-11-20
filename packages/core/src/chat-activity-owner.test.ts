import { describe, expect, test } from "bun:test";
import { type ChatActivity, type ChatEvent, ownsChatActivity } from "./chat.js";

const tool: ChatActivity = {
  type: "tool",
  id: "tool-1",
  name: "shell",
  input: '{"command":"ci"}',
  startedAt: 1,
};
const plan: ChatActivity = { type: "plan", id: "plan", entries: [] };
const subagent: ChatActivity = {
  type: "subagent",
  id: "task-1",
  title: "Review",
  status: "running",
  activity: [],
};

describe("ownsChatActivity", () => {
  test("a tool result belongs to the segment holding the call", () => {
    const event: ChatEvent = {
      type: "tool_result",
      data: { toolUseId: "tool-1", content: "ok", isError: false },
    };
    expect(ownsChatActivity([tool], event)).toBe(true);
    expect(ownsChatActivity([{ ...tool, id: "other" }], event)).toBe(false);
    expect(ownsChatActivity([], event)).toBe(false);
    expect(ownsChatActivity(undefined, event)).toBe(false);
  });

  test("plan snapshots and subagent status route to their entry", () => {
    const planEvent: ChatEvent = {
      type: "plan",
      data: { id: "plan", entries: [] },
    };
    const subagentEvent: ChatEvent = {
      type: "subagent",
      data: { id: "task-1", title: "Review", status: "completed", activity: [] },
    };
    expect(ownsChatActivity([plan], planEvent)).toBe(true);
    expect(ownsChatActivity([tool], planEvent)).toBe(false);
    expect(ownsChatActivity([subagent], subagentEvent)).toBe(true);
    expect(ownsChatActivity([{ ...subagent, id: "other" }], subagentEvent)).toBe(false);
  });

  test("a same-id tool re-announcement belongs to the segment holding the call", () => {
    const update: ChatEvent = {
      type: "tool_use",
      data: { id: "tool-1", name: "shell", input: '{"command":"ci --fix"}' },
    };
    expect(ownsChatActivity([tool], update)).toBe(true);
    expect(ownsChatActivity([{ ...tool, id: "other" }], update)).toBe(false);
  });

  test("append-only events never claim an owner", () => {
    expect(ownsChatActivity([tool], { type: "text", text: "hello" })).toBe(false);
    expect(
      ownsChatActivity([tool], {
        type: "tool_use",
        data: { id: "tool-2", name: "shell", input: "{}" },
      }),
    ).toBe(false);
  });
});
