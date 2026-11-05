import { expect, test } from "bun:test";
import type { ChatActivity } from "@orc/core/chat";
import { activitySummary, groupChatActivity } from "../../src/lib/chat-activity";

test("should merge each run of thinking and tools into one group, split only by status", () => {
  const items: ChatActivity[] = [
    { type: "tool", id: "a", name: "read", input: "a", result: "ok" },
    { type: "tool", id: "b", name: "run", input: "b", isError: true, result: "failed" },
    { type: "thinking", id: "c", text: "Next" },
    { type: "tool", id: "d", name: "read", input: "d" },
    { type: "status", id: "e", text: "Waiting" },
    { type: "tool", id: "f", name: "read", input: "f" },
    { type: "status", id: "g", text: "Done" },
    { type: "thinking", id: "h", text: "One" },
    { type: "thinking", id: "i", text: "Two" },
  ];
  const groups = groupChatActivity(items);
  expect(groups.map((group) => group.type)).toEqual(["tools", "status", "tool", "status", "tools"]);
  expect(groups[0]).toEqual({ type: "tools", id: "a", items: items.slice(0, 4) });
  expect(items).toHaveLength(9);
  expect(groupChatActivity([])).toEqual([]);
  expect(groupChatActivity(items.slice(0, 1))).toEqual(items.slice(0, 1));
});

test("should summarise tool calls and thoughts with singular and plural forms", () => {
  const tool = { type: "tool", id: "t", name: "read", input: "" } as const;
  const thought = { type: "thinking", id: "h", text: "x" } as const;
  expect(activitySummary([tool, tool, thought])).toBe("2 tool calls · 1 thought");
  expect(activitySummary([tool])).toBe("1 tool call");
  expect(activitySummary([thought, thought])).toBe("2 thoughts");
});
