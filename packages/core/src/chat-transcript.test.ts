import { expect, test } from "bun:test";
import { ChatThreadSchema, parseChatThread, readChatActivity } from "./chat";

const thread = (activity: unknown[]) => ({
  id: "3f0c831c-500d-4ae5-9c83-0d2bc6c431fa",
  title: "Stored chat",
  config: { agent: "codex" },
  cwd: "C:/work",
  host: null,
  runtimeId: "runtime-1",
  backend: "codex",
  sourceId: null,
  messages: [
    {
      id: "m1",
      role: "assistant",
      content: "Answer",
      timestamp: 1,
      agent: "codex",
      activity,
    },
  ],
  updatedAt: 1,
});

test("should read a transcript written before plans and provider passthrough existed", () => {
  const stored = parseChatThread(
    thread([
      { type: "thinking", id: "t1", text: "Reasoning" },
      { type: "tool", id: "a1", name: "read", input: "{}", result: "ok" },
      { type: "status", id: "s1", text: "Rule gap" },
    ]),
  );
  expect(stored.messages[0]?.activity).toHaveLength(3);
  expect(stored.messages[0]?.providerActivity).toBeUndefined();
  // A parsed thread still satisfies the strict contract.
  expect(ChatThreadSchema.safeParse(JSON.parse(JSON.stringify(stored))).success).toBe(true);
});

test("should keep an unknown activity kind instead of throwing or dropping it", () => {
  const stored = parseChatThread(
    thread([
      { type: "thinking", id: "t1", text: "Reasoning" },
      { type: "diff_review", id: "d1", hunks: 3 },
    ]),
  );
  expect(stored.messages[0]?.activity).toEqual([{ type: "thinking", id: "t1", text: "Reasoning" }]);
  expect(stored.messages[0]?.providerActivity).toEqual([
    { id: "d1", kind: "diff_review", data: { type: "diff_review", id: "d1", hunks: 3 } },
  ]);
  // Re-saving and reading again keeps the passthrough rather than losing it.
  const reloaded = parseChatThread(JSON.parse(JSON.stringify(stored)));
  expect(reloaded.messages[0]?.providerActivity).toEqual(stored.messages[0]?.providerActivity);
});

test("should split activity without trusting malformed items", () => {
  expect(readChatActivity("not-a-list")).toEqual({ activity: [], provider: [] });
  const split = readChatActivity([
    { type: "status", id: "s1", text: "Visible" },
    null,
    { type: 42 },
    { type: "plan", entries: [] },
    { no: "id" },
  ]);
  expect(split.activity).toEqual([{ type: "status", id: "s1", text: "Visible" }]);
  expect(split.provider.map((item) => item.kind)).toEqual([
    "unknown",
    "unknown",
    "plan",
    "unknown",
  ]);
  expect(split.provider.every((item) => item.id.length > 0)).toBe(true);
});
