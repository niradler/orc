import { expect, test } from "bun:test";
import { chatHistory } from "../sessions/chat-history";

test("imported chat history retains thinking and tool results without blank user messages", () => {
  const history = chatHistory(
    [
      {
        index: 0,
        role: "user",
        time: "not-a-date",
        blocks: [{ type: "text", text: "Original question" }],
      },
      {
        index: 1,
        role: "assistant",
        time: null,
        blocks: [
          { type: "thinking", text: "Provider summary" },
          { type: "tool_use", id: "call-1", name: "read", input: "file" },
        ],
      },
      {
        index: 2,
        role: "tool",
        time: null,
        blocks: [{ type: "tool_result", forId: "call-1", text: "File content" }],
      },
      {
        index: 3,
        role: "assistant",
        time: null,
        blocks: [{ type: "text", text: "Original answer" }],
      },
      {
        index: 4,
        role: "system",
        time: null,
        blocks: [{ type: "text", text: "Internal wrapper" }],
      },
    ],
    "codex",
  );
  expect(history).toHaveLength(3);
  expect(Number.isFinite(history[0]?.timestamp)).toBe(true);
  expect(history[1]?.activity).toMatchObject([
    { type: "thinking", text: "Provider summary" },
    { type: "tool", id: "call-1", name: "read", result: "File content" },
  ]);
  expect(history[2]?.content).toBe("Original answer");
});
