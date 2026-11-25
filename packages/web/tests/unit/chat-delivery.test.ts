import { describe, expect, test } from "bun:test";
import {
  parseSessionDeliveryEnvelope,
  type SessionDelivery,
  SessionMessageSchema,
  sessionMessageContext,
} from "@orc/core/session-messages";
import { deliverySessionHref } from "../../src/lib/session-links";

describe("chat delivery presentation helpers", () => {
  test("builds child thread links for child outcomes and live session links for relays", () => {
    const child: SessionDelivery = {
      kind: "child_outcome",
      session_id: "thread-child-1",
      title: "Worker A",
      outcome: "finished",
      summary: "All tests green",
    };
    const relay: SessionDelivery = {
      kind: "relay",
      session_id: "session-peer-2",
      title: "session peer-2 (claude)",
      summary: "Check the retry path",
    };
    const human: SessionDelivery = {
      kind: "relay",
      session_id: null,
      title: "human relay (ORC web)",
      summary: "Ship when ready",
    };

    expect(deliverySessionHref(child)).toBe("/chat?chatThread=thread-child-1");
    expect(deliverySessionHref(relay)).toBe("/chat?sessionLive=session-peer-2");
    expect(deliverySessionHref(human)).toBeNull();
  });

  test("parses legacy envelopes wrapped with orc-context", () => {
    const msg = SessionMessageSchema.parse({
      id: "01J00000000000000000000099",
      project_id: null,
      target_session_id: "parent-1",
      target_native_id: null,
      target_backend: "claude",
      sender_kind: "system",
      sender_session_id: "child-77",
      sender_native_id: null,
      sender_backend: "claude",
      sender_label: "child session Build check",
      body: [
        "[orc child-session id=child-77 outcome=failed]",
        'Child session "Build check" failed.',
        "",
        "Last reply:",
        "TypeScript reported 3 errors in routes/chat.ts.",
        "",
        'Read more with session_status {"session_id":"child-77"}; reply with session_send.',
      ].join("\n"),
      position: 0,
      hop: 0,
      state: "delivered",
      delivered_via: "chat",
      delivery_error: null,
      request_id: null,
      created_at: 1000,
      updated_at: 1000,
      delivered_at: 2000,
    });
    const wrapped = `<orc-context>\nsource: webchat\n</orc-context>\n\n${sessionMessageContext([msg])}`;
    const parsed = parseSessionDeliveryEnvelope(wrapped);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]).toMatchObject({
      kind: "child_outcome",
      session_id: "child-77",
      title: "Build check",
      outcome: "failed",
      summary: "TypeScript reported 3 errors in routes/chat.ts.",
    });
  });
});
