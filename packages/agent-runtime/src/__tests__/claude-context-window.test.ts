import { expect, test } from "bun:test";
import { claudeContextWindow } from "../claude-sdk.js";

const result = JSON.parse(
  '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"usage":{"input_tokens":2,"cache_creation_input_tokens":31866,"cache_read_input_tokens":10601,"output_tokens":4},"modelUsage":{"claude-opus-5-5[1m]":{"inputTokens":2,"outputTokens":4,"cacheReadInputTokens":10601,"cacheCreationInputTokens":31866,"webSearchRequests":0,"costUSD":0.2571362,"contextWindow":1000000,"maxOutputTokens":128000,"thinkingTokens":0,"canonicalModel":"claude-opus-5-5","provider":"firstParty","costBasis":"list"}}}',
);

test("should read the context window of the session's model from a Claude SDK result", () => {
  expect(claudeContextWindow(result.modelUsage, "claude-opus-5-5[1m]")).toBe(1_000_000);
  expect(claudeContextWindow(result.modelUsage, undefined)).toBe(1_000_000);
});

test("should not guess a window when several models ran and none is the session's", () => {
  const withSubagent = {
    ...result.modelUsage,
    "claude-haiku-4-5": { ...result.modelUsage["claude-opus-5-5[1m]"], contextWindow: 200_000 },
  };
  expect(claudeContextWindow(withSubagent, "claude-haiku-4-5")).toBe(200_000);
  expect(claudeContextWindow(withSubagent, "claude-sonnet-4-5")).toBeUndefined();
  expect(claudeContextWindow(undefined, "claude-opus-5-5[1m]")).toBeUndefined();
  expect(claudeContextWindow({ m: { contextWindow: "1000000" } }, "m")).toBeUndefined();
});
