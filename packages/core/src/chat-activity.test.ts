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
    },
  ]);
});
