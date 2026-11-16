import { expect, test } from "bun:test";
import type { ChatMessage } from "@orc/core/chat";
import { groupChatMessages } from "../../src/lib/chat-message-groups";

const message = (id: string, role: ChatMessage["role"], content = "", tools = 0): ChatMessage => ({
  id,
  role,
  content,
  timestamp: 1,
  activity: Array.from({ length: tools }, (_, index) => ({
    type: "tool" as const,
    id: `${id}-${index}`,
    name: "Bash",
    input: "ls",
  })) as ChatMessage["activity"],
});

test("folds consecutive assistant messages into one turn keyed by its last message", () => {
  const messages = [
    message("u1", "user", "Run it"),
    message("a1", "assistant", "Starting"),
    message("a2", "assistant", "", 1),
    message("a3", "assistant", "", 2),
    message("a4", "assistant", "Done"),
    message("u2", "user", "Again"),
    message("a5", "assistant", "", 1),
  ];
  const { messages: grouped, displayId } = groupChatMessages(messages);
  expect(grouped.map((entry) => entry.id)).toEqual(["u1", "a4", "u2", "a5"]);
  expect(grouped[1]?.content).toBe("Starting\n\nDone");
  expect(grouped[1]?.activity).toHaveLength(3);
  expect(displayId.get("a2")).toBe("a4");
  expect(grouped[3]).toBe(messages[6]);
  expect(groupChatMessages(messages)).toBe(groupChatMessages(messages));
});
