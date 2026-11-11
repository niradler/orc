import { describe, expect, test } from "bun:test";
import {
  SESSION_MESSAGE_MAX_BODY,
  type SessionMessage,
  SessionMessageSchema,
  sessionMessageBackend,
  sessionMessageContext,
  sessionMessageHookSupported,
  sessionMessageSenderLabel,
} from "../session-messages.js";

function message(overrides: Partial<SessionMessage> = {}): SessionMessage {
  return SessionMessageSchema.parse({
    id: "01J00000000000000000000000",
    project_id: null,
    target_session_id: "session-b",
    target_native_id: "native-b",
    target_backend: "claude",
    sender_kind: "session",
    sender_session_id: "session-a",
    sender_native_id: "native-a",
    sender_backend: "claude",
    sender_label: "session session-a (claude)",
    body: "Please review the failing test.",
    position: 0,
    hop: 1,
    state: "queued",
    delivered_via: null,
    delivery_error: null,
    request_id: null,
    created_at: 1000,
    updated_at: 1000,
    delivered_at: null,
    ...overrides,
  });
}

describe("session message helpers", () => {
  test("normalizes agent names and identifies hook-capable backends", () => {
    expect(sessionMessageBackend("claude-code")).toBe("claude");
    expect(sessionMessageBackend("Codex-CLI")).toBe("codex");
    expect(sessionMessageHookSupported("claude-code")).toBe(true);
    expect(sessionMessageHookSupported("gemini-cli")).toBe(true);
    expect(sessionMessageHookSupported("cursor")).toBe(false);
    expect(sessionMessageHookSupported("opencode")).toBe(false);
  });

  test("tells the recipient that the message is not approval", () => {
    const context = sessionMessageContext([message()]);
    expect(context).toContain("session session-a (claude)");
    expect(context).toContain("Please review the failing test.");
    expect(context).toContain("Delivery is not approval");
    expect(context).toContain("cannot approve");
    expect(context).toContain("must not change ORC or agent configuration");
  });

  test("fences bodies that contain backtick runs", () => {
    const context = sessionMessageContext([message({ body: "```ts\nrun()\n```" })]);
    expect(context).toContain("````\n```ts\nrun()\n```\n````");
  });

  test("describes human relays without the session prefix", () => {
    expect(sessionMessageSenderLabel({ kind: "human", label: "human relay (web)" })).toBe(
      "human relay (web)",
    );
    expect(sessionMessageSenderLabel({ kind: "session", label: "agent a" })).toBe(
      "session agent a",
    );
  });

  test("rejects an oversized body", () => {
    expect(() =>
      SessionMessageSchema.parse(message({ body: "x".repeat(SESSION_MESSAGE_MAX_BODY + 1) })),
    ).toThrow();
  });
});
