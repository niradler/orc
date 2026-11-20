import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@orc/core/chat";
import { type InterjectionState, withInterjection } from "../../src/lib/chat-interjection";

const user = (id: string, content: string): ChatMessage => ({
  id,
  role: "user",
  content,
  timestamp: 1,
});
const answer = user("answer-1", "Choose a color: Blue");

function state(overrides: Partial<InterjectionState> = {}): InterjectionState {
  return {
    messages: [user("first", "Pick a color")],
    streamText: "",
    activity: [],
    assistantId: "live-1",
    respondingAgent: "codex",
    ...overrides,
  };
}

describe("withInterjection", () => {
  test("freezes the prose streamed so far before the human message", () => {
    const change = withInterjection(state({ streamText: "Part one." }), answer);
    expect(change.messages.map((message) => `${message.role}: ${message.content}`)).toEqual([
      "user: Pick a color",
      "assistant: Part one.",
      "user: Choose a color: Blue",
    ]);
    expect(change.messages[1]?.id).toBe("live-1");
    expect(change.streamText).toBe("");
    expect(change.activity).toEqual([]);
    expect(change.assistantId).not.toBe("live-1");
  });

  test("an activity-only stream is frozen too, and an empty one adds no segment", () => {
    const activity = [{ type: "status" as const, id: "s", text: "Working" }];
    const busy = withInterjection(state({ activity }), answer);
    expect(busy.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(busy.messages[1]?.activity).toEqual(activity);
    const empty = withInterjection(state(), answer);
    expect(empty.messages.map((message) => message.role)).toEqual(["user", "user"]);
  });

  test("the event and the HTTP response split only once, whichever arrives first", () => {
    const first = withInterjection(state({ streamText: "Part one." }), answer);
    const next = state({
      messages: first.messages,
      streamText: "Part two.",
      assistantId: first.assistantId ?? "live-2",
    });
    // The later copy of the same message upserts in place; the new prose survives.
    const second = withInterjection(next, { ...answer, content: "Choose a color: Blue (edited)" });
    expect(second.messages).toHaveLength(3);
    expect(second.messages[2]?.content).toBe("Choose a color: Blue (edited)");
    expect(second.streamText).toBeUndefined();
    expect(second.assistantId).toBeUndefined();
  });
});
