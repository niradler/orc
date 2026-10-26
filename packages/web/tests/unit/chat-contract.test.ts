import { describe, expect, test } from "bun:test";
import { ChatSettingsSchema } from "@orc/core/chat";
import {
  parseChatEvent,
  parseChatPreferences,
  parseChatTabs,
  withPreferences,
} from "../../src/hooks/chat-contract";

describe("chat preferences", () => {
  test("saved agent, model and permissions overlay the server defaults", () => {
    const defaults = ChatSettingsSchema.parse({ agent: "codex", model: "gpt" });
    expect(parseChatPreferences(null)).toEqual({});
    const saved = parseChatPreferences(
      '{"agent":"claude","model":"opus","permissionMode":"bypassPermissions"}',
    );
    expect(withPreferences(defaults, saved)).toMatchObject({
      agent: "claude",
      model: "opus",
      permissionMode: "bypassPermissions",
    });
    expect(withPreferences(defaults, { agent: "claude" }).model).toBe("");
    expect(withPreferences(defaults, { model: "gpt-5" }).model).toBe("gpt-5");
  });

  test("malformed storage and invalid input cannot become an agent request", () => {
    for (const raw of [
      "broken",
      "null",
      "[]",
      '{"agent":"--help"}',
      '{"permissionMode":"yolo"}',
      '{"system":"injected"}',
    ]) {
      expect(parseChatPreferences(raw)).toEqual({});
    }
  });

  test("open tabs keep only valid conversation ids", () => {
    const id = "3f0c831c-500d-4ae5-9c83-0d2bc6c431fa";
    expect(parseChatTabs(JSON.stringify({ threads: [id, "../x", 4], active: id }))).toEqual({
      threads: [id],
      active: id,
    });
    expect(parseChatTabs(JSON.stringify({ threads: [id], active: "other" })).active).toBeNull();
    expect(parseChatTabs("broken")).toEqual({ threads: [], active: null });
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
