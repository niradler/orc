import { describe, expect, test } from "bun:test";
import { parseChatConfig, parseChatEvent } from "../../src/hooks/chat-contract";

describe("chat preferences", () => {
  test("first visit uses Codex and saved valid selections remain authoritative", () => {
    expect(parseChatConfig(null)).toEqual({ agent: "codex", autoApprove: true });
    expect(parseChatConfig('{"agent":"claude","autoApprove":false}')).toEqual({
      agent: "claude",
      autoApprove: false,
    });
    expect(parseChatConfig('{"agent":"custom-agent","autoApprove":true}').agent).toBe(
      "custom-agent",
    );
  });

  test("malformed storage and invalid input cannot become an agent request", () => {
    for (const raw of [
      "broken",
      "null",
      "[]",
      '{"agent":"--help","autoApprove":true}',
      '{"agent":"claude","autoApprove":"false"}',
    ]) {
      expect(parseChatConfig(raw)).toEqual({ agent: "codex", autoApprove: true });
    }
  });
});

describe("chat SSE contract", () => {
  test("recognizes text and structured errors without adding transport markers to responses", () => {
    expect(parseChatEvent('data: {"type":"text","text":"hello 🚀"}\r')).toEqual({
      type: "text",
      text: "hello 🚀",
    });
    expect(parseChatEvent('data:{"type":"error","message":"Backend unavailable"}')).toEqual({
      type: "error",
      message: "Backend unavailable",
    });
    expect(parseChatEvent('data: {"type":"error","message":{"private":"data"}}')).toEqual({
      type: "error",
      message: "The agent could not complete the response.",
    });
    for (const line of [
      ": keepalive",
      'data: {"type":"open"}',
      'data: {"type":"done"}',
      'data: {"type":"text","text":42}',
      "data: [1]",
      "data: broken",
    ]) {
      expect(parseChatEvent(line)).toBeNull();
    }
  });
});
