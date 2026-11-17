import { expect, test } from "bun:test";
import { chatDividers, compactionDividerLabel } from "../../src/lib/chat-dividers";

const message = (
  id: string,
  role: "user" | "assistant",
  timestamp: number,
): { id: string; role: "user" | "assistant"; timestamp: number } => ({ id, role, timestamp });

test("should carry a recorded compaction trigger onto the divider", () => {
  const messages = [message("q", "user", 0), message("a", "assistant", 10_000)];
  const at = new Date(1_500).toISOString();
  const compact = (trigger?: "manual" | "auto" | null) => ({
    recorded_at: at,
    pre_tokens: 448_563,
    post_tokens: 41_112,
    ...(trigger === undefined ? {} : { trigger }),
  });

  expect(chatDividers(messages, [compact("auto")]).byMessage.get("a")).toEqual([
    { type: "compact", pre: 448_563, post: 41_112, trigger: "auto" },
  ]);
  expect(chatDividers(messages, [compact("manual")]).byMessage.get("a")?.[0]).toMatchObject({
    trigger: "manual",
  });
  // A compaction payload without a trigger stays unknown rather than guessed.
  expect(chatDividers(messages, [compact()]).byMessage.get("a")?.[0]).toMatchObject({
    trigger: null,
  });
  expect(chatDividers(messages, [compact(null)]).byMessage.get("a")?.[0]).toMatchObject({
    trigger: null,
  });
});

test("should name only a recorded trigger and omit missing sizes", () => {
  expect(compactionDividerLabel({ pre: 448_563, post: 41_112, trigger: "auto" })).toEqual({
    label: "Context compacted automatically",
    drop: "449k → 41k tokens",
  });
  expect(compactionDividerLabel({ pre: 182_000, post: 24_000, trigger: "manual" })).toEqual({
    label: "Context compacted manually",
    drop: "182k → 24k tokens",
  });
  expect(compactionDividerLabel({ pre: null, post: null, trigger: null })).toEqual({
    label: "Context compacted",
    drop: null,
  });
  // One missing side drops the whole comparison instead of showing a zero.
  expect(compactionDividerLabel({ pre: 182_000, post: null, trigger: "auto" })).toEqual({
    label: "Context compacted automatically",
    drop: null,
  });
});
