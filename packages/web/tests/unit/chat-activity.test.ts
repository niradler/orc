import { expect, test } from "bun:test";
import type { ChatActivity } from "@orc/core/chat";
import { groupChatActivity } from "../../src/lib/chat-activity";

test("should collapse only adjacent tools and preserve thinking/status boundaries and results", () => {
  const items: ChatActivity[] = [
    { type: "tool", id: "a", name: "read", input: "a", result: "ok" },
    { type: "tool", id: "b", name: "run", input: "b", isError: true, result: "failed" },
    { type: "thinking", id: "c", text: "Next" },
    { type: "tool", id: "d", name: "read", input: "d" },
    { type: "status", id: "e", text: "Waiting" },
    { type: "tool", id: "f", name: "read", input: "f" },
    { type: "tool", id: "g", name: "read", input: "g" },
  ];
  const groups = groupChatActivity(items);
  expect(groups.map((group) => group.type)).toEqual([
    "tools",
    "thinking",
    "tool",
    "status",
    "tools",
  ]);
  expect(groups[0]).toEqual({ type: "tools", id: "a", items: items.slice(0, 2) });
  expect(items).toHaveLength(7);
  expect(groupChatActivity([])).toEqual([]);
  expect(groupChatActivity(items.slice(0, 1))).toEqual(items.slice(0, 1));
});
