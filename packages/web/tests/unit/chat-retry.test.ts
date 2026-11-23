import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatTurn } from "@orc/core/chat";
import { retryPrompt } from "../../src/lib/chat-retry";

const user = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: "user",
  content,
  timestamp: 1,
  ...extra,
});

const assistant = (
  id: string,
  turn: ChatTurn = { startedAt: 1, finishedAt: 2, outcome: "interrupted" },
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id,
  role: "assistant",
  content: "",
  timestamp: 2,
  turn,
  ...extra,
});

describe("retryPrompt", () => {
  test("returns the prompt of an interrupted turn that did work", () => {
    const messages = [
      user("u1", "Ship the fix"),
      assistant("a1", undefined, { content: "Started." }),
    ];
    expect(retryPrompt(messages, "a1")).toEqual({ prompt: "Ship the fix", received: true });
  });

  test("counts activity as work even when no prose was recorded", () => {
    const messages = [
      user("u1", "Ship the fix"),
      assistant("a1", undefined, { activity: [{ type: "system_status", text: "running" }] }),
    ];
    expect(retryPrompt(messages, "a1")).toEqual({ prompt: "Ship the fix", received: true });
  });

  test("marks a turn with no recorded work as possibly unreceived", () => {
    const messages = [user("u1", "Ship the fix"), assistant("a1")];
    expect(retryPrompt(messages, "a1")).toEqual({ prompt: "Ship the fix", received: false });
  });

  test("ignores turns that ended normally, were stopped or failed", () => {
    const messages = [
      user("u1", "Ship the fix"),
      assistant("a1", { startedAt: 1, finishedAt: 2, outcome: "completed" }),
      assistant("a2", { startedAt: 3, outcome: "stopped" }),
      assistant("a3", { startedAt: 4, outcome: "failed" }),
    ];
    expect(retryPrompt(messages, "a1")).toBeNull();
    expect(retryPrompt(messages, "a2")).toBeNull();
    expect(retryPrompt(messages, "a3")).toBeNull();
  });

  test("skips sealed assistant segments between the prompt and the turn", () => {
    const messages = [
      user("u1", "Ship the fix"),
      { id: "a0", role: "assistant", content: "Halfway.", timestamp: 2 } satisfies ChatMessage,
      assistant("a1", undefined, { content: "Continuing." }),
    ];
    expect(retryPrompt(messages, "a1")?.prompt).toBe("Ship the fix");
  });

  test("refuses to resend a prompt whose attachments would be dropped", () => {
    const messages = [
      user("u1", "Read this", {
        attachments: [
          {
            id: "f1",
            name: "report.pdf",
            path: "/tmp/report.pdf",
            size: 12,
            mimeType: "application/pdf",
          },
        ],
      }),
      assistant("a1", undefined, { content: "Started." }),
    ];
    expect(retryPrompt(messages, "a1")).toBeNull();
  });

  test("returns null when no user prompt precedes the turn", () => {
    expect(retryPrompt([assistant("a1")], "a1")).toBeNull();
    expect(retryPrompt([], "missing")).toBeNull();
  });

  test("ignores an empty prompt", () => {
    const messages = [user("u1", "   "), assistant("a1")];
    expect(retryPrompt(messages, "a1")).toBeNull();
  });
});
