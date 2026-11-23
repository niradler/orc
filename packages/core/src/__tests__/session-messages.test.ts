import { describe, expect, test } from "bun:test";
import {
  childOutcomeSummary,
  deliverySummary,
  parseChildNotice,
  parseSessionDeliveryEnvelope,
  SESSION_MESSAGE_MAX_BODY,
  type SessionMessage,
  SessionMessageSchema,
  sessionDeliveryFromMessage,
  sessionMessageBackend,
  sessionMessageContext,
  sessionMessageHookSupported,
  sessionMessageReceipt,
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

  test("summarizes markdown text into a single concise line", () => {
    expect(deliverySummary("## Summary\n\n- Fixed the auth race\n- Added tests")).toBe(
      "Summary Fixed the auth race Added tests",
    );
    expect(deliverySummary("a".repeat(200), 20)).toBe(`${"a".repeat(19)}…`);
  });

  test("parses child outcome notices and normalizes waiting states", () => {
    const notice = [
      "[orc child-session id=child-1 outcome=finished]",
      'Child session "Fix auth tests" finished.',
      "",
      "Last reply:",
      "All 14 tests pass now.",
      "",
      'Read more with session_status {"session_id":"child-1"}; reply with session_send.',
    ].join("\n");
    expect(parseChildNotice(notice)).toEqual({
      sessionId: "child-1",
      outcome: "finished",
      title: "Fix auth tests",
      reply: "All 14 tests pass now.",
    });

    const waiting = [
      "[orc child-session id=child-2 outcome=approval]",
      'Child session "Deploy worker" is waiting for a human approval; you cannot answer it, a human must.',
      "",
      'Read more with session_status {"session_id":"child-2"}; reply with session_send.',
    ].join("\n");
    expect(parseChildNotice(waiting)).toEqual({
      sessionId: "child-2",
      outcome: "waiting",
      waitingFor: "approval",
      title: "Deploy worker",
      reply: "",
    });
    expect(childOutcomeSummary("waiting", "", "approval")).toBe("Waiting for human approval");
  });

  test("prefers structured delivery metadata and falls back to parsing message body", () => {
    const withDelivery = message({
      sender_kind: "system",
      sender_session_id: "child-9",
      sender_label: "child session Lint pass",
      delivery: {
        kind: "child_outcome",
        session_id: "child-9",
        title: "Lint pass",
        outcome: "failed",
        summary: "Biome reported 2 errors",
        body: "Detailed Biome output",
      },
    });
    expect(sessionDeliveryFromMessage(withDelivery)).toMatchObject({
      id: withDelivery.id,
      kind: "child_outcome",
      session_id: "child-9",
      title: "Lint pass",
      outcome: "failed",
      summary: "Biome reported 2 errors",
      body: "Detailed Biome output",
    });

    const relay = sessionDeliveryFromMessage(
      message({
        sender_kind: "human",
        sender_session_id: null,
        sender_label: "human relay (ORC web)",
        body: "Please double-check the migration.",
      }),
    );
    expect(relay).toMatchObject({
      kind: "relay",
      session_id: null,
      title: "human relay (ORC web)",
      summary: "Please double-check the migration.",
      body: "Please double-check the migration.",
    });
  });

  test("parses canonical plain-text delivery envelopes as fallback and ignores ordinary prose", () => {
    const childMsg = message({
      id: "01J00000000000000000000001",
      sender_kind: "system",
      sender_session_id: "child-1",
      sender_label: "child session API audit",
      hop: 0,
      body: [
        "[orc child-session id=child-1 outcome=finished]",
        'Child session "API audit" finished.',
        "",
        "Last reply:",
        "Checked ```ts\nrun()\n``` and all routes passed.",
        "",
        'Read more with session_status {"session_id":"child-1"}; reply with session_send.',
      ].join("\n"),
    });
    const relayMsg = message({
      id: "01J00000000000000000000002",
      sender_kind: "human",
      sender_session_id: null,
      sender_label: "human relay (ORC web)",
      hop: 0,
      body: "Focus on flaky tests first.",
    });
    const envelope = sessionMessageContext([childMsg, relayMsg]);
    const parsed = parseSessionDeliveryEnvelope(envelope);
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]).toMatchObject({
      id: "01J00000000000000000000001",
      kind: "child_outcome",
      session_id: "child-1",
      title: "API audit",
      outcome: "finished",
    });
    expect(parsed?.[0]?.body).toContain("```ts\nrun()\n```");
    expect(parsed?.[1]).toMatchObject({
      id: "01J00000000000000000000002",
      kind: "relay",
      session_id: null,
      title: "human relay (ORC web)",
      summary: "Focus on flaky tests first.",
      body: "Focus on flaky tests first.",
    });
    expect(parseSessionDeliveryEnvelope("Can you summarize ORC delivered messages?")).toBeNull();
  });

  test("maps delivery modes to receipts with do-not-poll guidance", () => {
    expect(sessionMessageReceipt("chat")).toMatchObject({ status: "queued" });
    expect(sessionMessageReceipt("hook")).toMatchObject({ status: "queued" });
    expect(sessionMessageReceipt("steer")).toMatchObject({ status: "steered" });
    expect(sessionMessageReceipt("resume")).toMatchObject({ status: "resumed" });
    expect(sessionMessageReceipt("unsupported")).toMatchObject({ status: "unsupported" });
    expect(sessionMessageReceipt("chat").note).toContain("Do not poll");
  });
});
