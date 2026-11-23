import { describe, expect, test } from "bun:test";
import { ChatSettingsSchema } from "@orc/core/chat";
import {
  chatSurfaceLinks,
  initialChatSurfaceLinks,
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
    const sideId = "4f0c831c-500d-4ae5-9c83-0d2bc6c431fb";
    expect(parseChatTabs(JSON.stringify({ threads: [id, "../x", 4], active: id }))).toEqual({
      threads: [id],
      active: id,
    });
    expect(
      parseChatTabs(JSON.stringify({ threads: [id, sideId], active: id, sideActive: sideId })),
    ).toEqual({
      threads: [id, sideId],
      active: id,
      sideActive: sideId,
    });
    expect(parseChatTabs(JSON.stringify({ threads: [id], active: id, sideActive: null }))).toEqual({
      threads: [id],
      active: id,
      sideActive: null,
    });
    expect(
      parseChatTabs(JSON.stringify({ threads: [id], active: id, sideActive: "other" })).sideActive,
    ).toBeNull();
    expect(parseChatTabs(JSON.stringify({ threads: [id], active: "other" })).active).toBeNull();
    expect(parseChatTabs("broken")).toEqual({ threads: [], active: null });
  });

  test("surface URL targeting keeps Chat page and side chat thread params independent", () => {
    const pageId = "3f0c831c-500d-4ae5-9c83-0d2bc6c431fa";
    const sideId = "4f0c831c-500d-4ae5-9c83-0d2bc6c431fb";
    expect(chatSurfaceLinks("/chat", `?chatThread=${pageId}`, true)).toEqual({
      pageShown: true,
      sideShown: false,
      redirecting: false,
      pageParam: "chatThread",
      sideParam: null,
      pageLinked: pageId,
      sideLinked: null,
    });
    expect(chatSurfaceLinks("/activity", `?chat=open&chatThread=${sideId}`, true)).toEqual({
      pageShown: false,
      sideShown: true,
      redirecting: false,
      pageParam: null,
      sideParam: "chatThread",
      pageLinked: null,
      sideLinked: sideId,
    });
    expect(
      chatSurfaceLinks("/chat", `?chat=open&chatThread=${pageId}&sideChatThread=${sideId}`, true),
    ).toEqual({
      pageShown: true,
      sideShown: true,
      redirecting: false,
      pageParam: "chatThread",
      sideParam: "sideChatThread",
      pageLinked: pageId,
      sideLinked: sideId,
    });
    expect(chatSurfaceLinks("/activity", `?chat=open&chatThread=${sideId}`, false)).toEqual({
      pageShown: false,
      sideShown: false,
      redirecting: true,
      pageParam: null,
      sideParam: null,
      pageLinked: null,
      sideLinked: null,
    });
    expect(chatSurfaceLinks("/tasks", `?chat=full&chatThread=${pageId}`, true)).toEqual({
      pageShown: true,
      sideShown: false,
      redirecting: true,
      pageParam: "chatThread",
      sideParam: null,
      pageLinked: pageId,
      sideLinked: null,
    });
  });

  test("narrow-viewport initial link capture preserves incoming deep links across redirect", () => {
    const pageId = "3f0c831c-500d-4ae5-9c83-0d2bc6c431fa";
    const sideId = "4f0c831c-500d-4ae5-9c83-0d2bc6c431fb";
    expect(initialChatSurfaceLinks("/activity", `?chat=open&chatThread=${sideId}`, false)).toEqual({
      pageShown: false,
      sideShown: false,
      redirecting: true,
      pageParam: null,
      sideParam: null,
      pageLinked: sideId,
      sideLinked: null,
    });
    expect(
      initialChatSurfaceLinks(
        "/chat",
        `?chat=open&chatThread=${pageId}&sideChatThread=${sideId}`,
        false,
      ),
    ).toEqual({
      pageShown: true,
      sideShown: false,
      redirecting: true,
      pageParam: "chatThread",
      sideParam: null,
      pageLinked: sideId,
      sideLinked: null,
    });
    expect(
      initialChatSurfaceLinks("/activity", "?chat=open&chatThread=not-a-uuid", false).pageLinked,
    ).toBeNull();
    expect(initialChatSurfaceLinks("/activity", `?chat=open&chatThread=${sideId}`, true)).toEqual(
      chatSurfaceLinks("/activity", `?chat=open&chatThread=${sideId}`, true),
    );
  });

  test("workspace project hints survive reload without trusting unrelated or malformed storage", () => {
    const id = "3f0c831c-500d-4ae5-9c83-0d2bc6c431fa";
    expect(
      parseChatTabs(
        JSON.stringify({ threads: [id], projectIds: { [id]: "project-a", other: "project-b" } }),
      ).projectIds,
    ).toEqual({ [id]: "project-a" });
    expect(
      parseChatTabs(JSON.stringify({ threads: [id], projectIds: { [id]: null } })).projectIds,
    ).toEqual({ [id]: null });
    for (const value of [42, "all", "unassigned", "", "x".repeat(101), {}]) {
      expect(
        parseChatTabs(JSON.stringify({ threads: [id], projectIds: { [id]: value } })).projectIds,
      ).toBeUndefined();
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
      'data: {"type":"text","text":42}',
      "data: [1]",
      "data: broken",
    ]) {
      expect(parseChatEvent(line)).toBeNull();
    }
    expect(parseChatEvent('data: {"type":"done"}')).toEqual({ type: "done" });
  });

  test("a mid-turn human interjection carries its recorded message", () => {
    const message = { id: "m1", role: "user", content: "Focus on tests", timestamp: 5 };
    expect(
      parseChatEvent(`data: {"type":"interjection","message":${JSON.stringify(message)}}`),
    ).toEqual({ type: "interjection", message });
    expect(parseChatEvent('data: {"type":"interjection"}')).toBeNull();
  });
});
