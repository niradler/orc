import { describe, expect, test } from "bun:test";
import type { ChatEvent, ChatMessage } from "@orc/core/chat";
import {
  activityUpdateTarget,
  type InterjectionState,
  withInterjection,
} from "../../src/lib/chat-interjection";

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

  test("the sealed segment carries the turn's agent and model", () => {
    const change = withInterjection(
      state({ streamText: "Part one.", thread: { config: { model: "gpt-fixture" } } }),
      answer,
    );
    expect(change.messages[1]?.agent).toBe("codex");
    expect(change.messages[1]?.model).toBe("gpt-fixture");
    expect(change.sealedId).toBe("live-1");
    // An empty stream freezes nothing, so there is no segment to track.
    expect(withInterjection(state(), answer).sealedId).toBeUndefined();
  });

  test("activity updates route only to segments sealed in the current run", () => {
    const planEvent: ChatEvent = { type: "plan", data: { id: "todos", entries: [] } };
    const previousTurnPlan: ChatMessage = {
      id: "old-plan",
      role: "assistant",
      content: "",
      timestamp: 1,
      activity: [{ type: "plan", id: "todos", entries: [] }],
    };
    const sealedPlan: ChatMessage = {
      id: "sealed-plan",
      role: "assistant",
      content: "",
      timestamp: 2,
      activity: [{ type: "plan", id: "todos", entries: [] }],
    };
    const messages = [user("first", "Pick a color"), previousTurnPlan, sealedPlan];
    // Plan ids are constant across turns: the previous turn's plan must not be
    // rewritten by the live turn's first plan event.
    expect(activityUpdateTarget(messages, ["sealed-plan"], planEvent)?.id).toBe("sealed-plan");
    expect(activityUpdateTarget(messages, [], planEvent)).toBeUndefined();
    const toolResult: ChatEvent = {
      type: "tool_result",
      data: { toolUseId: "tool-1", content: "ok", isError: false },
    };
    const sealedTool: ChatMessage = {
      id: "sealed-tool",
      role: "assistant",
      content: "",
      timestamp: 3,
      activity: [{ type: "tool", id: "tool-1", name: "shell", input: "{}", startedAt: 1 }],
    };
    expect(activityUpdateTarget([sealedTool], ["sealed-tool"], toolResult)?.id).toBe("sealed-tool");
    expect(activityUpdateTarget([sealedTool], [], toolResult)).toBeUndefined();
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
