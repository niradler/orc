import { expect, test } from "bun:test";
import {
  parseClaudeUsage,
  parseCodexUsage,
  parseGeminiUsage,
  parseOpenCodeUsage,
  parsePiUsage,
} from "../sessions/usage-parsers";

test("should split Claude message usage once and separate thinking from output", () => {
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-13T10:00:00.000Z",
      message: {
        id: "msg-1",
        model: "claude-sonnet",
        usage: {
          input_tokens: 10,
          output_tokens: 50,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
          output_tokens_details: { thinking_tokens: 30 },
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-13T10:00:01.000Z",
      message: {
        id: "msg-1",
        model: "claude-sonnet",
        usage: { input_tokens: 999, output_tokens: 999 },
      },
    }),
    JSON.stringify({ type: "user", message: { content: "hi" } }),
  ];
  const usage = parseClaudeUsage(lines.join("\n"), 0);
  expect(usage.tokens).toBe(180);
  expect(usage.model).toBe("claude-sonnet");
  expect(usage.events).toHaveLength(1);
  expect(usage.events[0]).toMatchObject({
    key: "msg-1",
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 30,
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
  });
});

test("should use Codex turn deltas, uncache cached input, and preserve unread totals", () => {
  const lines = [
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6" } }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-11-13T10:00:00.000Z",
      payload: {
        type: "token_count",
        info: {
          last_usage_includes_reasoning: true,
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 400,
            cache_write_input_tokens: 10,
            output_tokens: 100,
            reasoning_output_tokens: 40,
            total_tokens: 1110,
          },
        },
      },
    }),
    "not json",
  ];
  const usage = parseCodexUsage(lines.join("\n"), 1500, 0);
  expect(usage.model).toBe("gpt-6");
  expect(usage.events).toHaveLength(2);
  expect(usage.events[0]).toMatchObject({
    inputTokens: 600,
    cacheReadTokens: 400,
    cacheWriteTokens: 10,
    outputTokens: 60,
    reasoningTokens: 40,
  });
  expect(usage.events[1]).toMatchObject({ key: "remainder", otherTokens: 390, estimated: true });
  expect(usage.tokens).toBe(1500);
});

test("should split Pi and OpenCode usage and keep their model identity", () => {
  const pi = parsePiUsage(
    [
      {
        id: "entry-1",
        timestamp: "2026-11-13T10:00:00.000Z",
        message: {
          role: "assistant",
          model: "deepseek-v4",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 300,
            cacheWrite: 5,
            reasoning: 10,
            totalTokens: 440,
          },
        },
      },
    ],
    0,
  );
  expect(pi.model).toBe("deepseek-v4");
  expect(pi.tokens).toBe(440);
  expect(pi.events[0]).toMatchObject({
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 300,
    cacheWriteTokens: 5,
    reasoningTokens: 10,
    otherTokens: 5,
  });

  const opencode = parseOpenCodeUsage([
    {
      id: "message-1",
      time_created: 1_760_000_000_000,
      data: JSON.stringify({
        model: { providerID: "bailian-cli", modelID: "deepseek-v4.1-flash" },
        tokens: { input: 7, output: 3, reasoning: 1, cache: { read: 9, write: 0 } },
      }),
    },
    { id: "message-2", data: "not json" },
  ]);
  expect(opencode.model).toBe("bailian-cli/deepseek-v4.1-flash");
  expect(opencode.tokens).toBe(20);
  expect(opencode.events[0]).toMatchObject({
    key: "message-1",
    inputTokens: 7,
    outputTokens: 3,
    reasoningTokens: 1,
    cacheReadTokens: 9,
  });
});

test("should mark Gemini and unsplit totals as estimated instead of inventing a split", () => {
  const usage = parseGeminiUsage(
    [
      { timestamp: "2026-11-13T10:00:00.000Z", tokens: { total: 120 } },
      { tokens: null },
      { tokens: { total: 30 } },
    ],
    1_760_000_000_000,
  );
  expect(usage.tokens).toBe(150);
  expect(usage.events).toHaveLength(2);
  expect(usage.events.every((event) => event.estimated)).toBe(true);
  expect(usage.events.every((event) => event.otherTokens > 0)).toBe(true);
  expect(usage.events[0]?.model).toBeNull();
});
