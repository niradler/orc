import { expect, test } from "bun:test";
import { chatHistory } from "../sessions/chat-history";

test("imported chat history retains the session's model when one is known", () => {
  const history = chatHistory(
    [{ index: 0, role: "assistant", time: null, blocks: [{ type: "text", text: "Answer" }] }],
    "codex",
    "gpt-5.1-codex",
  );
  expect(history[0]?.model).toBe("gpt-5.1-codex");
  expect(chatHistory([], "codex")[0]).toBeUndefined();
});

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

test("imported chat history times each turn from the prompt to its last answer", () => {
  const at = (minute: number) => `2026-11-16T10:${String(minute).padStart(2, "0")}:00Z`;
  const ms = (minute: number) => Date.parse(at(minute));
  const history = chatHistory(
    [
      { index: 0, role: "user", time: at(0), blocks: [{ type: "text", text: "First" }] },
      { index: 1, role: "assistant", time: at(1), blocks: [{ type: "text", text: "Working" }] },
      { index: 2, role: "assistant", time: at(3), blocks: [{ type: "text", text: "Done" }] },
      { index: 3, role: "user", time: null, blocks: [{ type: "text", text: "Second" }] },
      { index: 4, role: "assistant", time: at(5), blocks: [{ type: "text", text: "Untimed" }] },
    ],
    "claude",
  );
  expect(history.map((message) => message.turn)).toEqual([
    undefined,
    undefined,
    { startedAt: ms(0), finishedAt: ms(3) },
    undefined,
    undefined,
  ]);
});
