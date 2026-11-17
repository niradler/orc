import { describe, expect, test } from "bun:test";
import {
  AGENT_STATE_ORDER,
  AGENT_STATES,
  liveSessionState,
  moreUrgent,
  rollupState,
  sendOutcome,
  waitingLabel,
} from "../../src/lib/agent-state";

describe("agent state language", () => {
  test("should map every live session status to one shared state", () => {
    expect(liveSessionState({ status: "running", waiting_for_human: true })).toBe("needs-you");
    expect(liveSessionState({ status: "error" })).toBe("failed");
    expect(liveSessionState({ status: "running" })).toBe("working");
    expect(liveSessionState({ status: "idle" })).toBe("idle");
    expect(liveSessionState({ status: "stopped" })).toBe("ended");
  });

  test("should prioritize actionable states ahead of quiet and unknown states", () => {
    expect(AGENT_STATE_ORDER).toEqual([
      "needs-you",
      "failed",
      "done",
      "working",
      "idle",
      "ended",
      "unknown",
    ]);
    expect(moreUrgent("working", "needs-you")).toBe("needs-you");
    expect(moreUrgent("failed", "done")).toBe("failed");
    expect(moreUrgent("idle", "ended")).toBe("idle");
    expect(moreUrgent("unknown", "working")).toBe("working");
  });

  test("should roll a group up to its most urgent child and stay quiet when nothing happens", () => {
    expect(rollupState(["idle", "working", "failed"])).toBe("failed");
    expect(rollupState(["idle", "ended", null])).toBeNull();
    expect(rollupState([])).toBeNull();
    expect(rollupState(["unknown", "idle"])).toBeNull();
  });

  test("should give each state a distinct word and icon so color is never the only signal", () => {
    const states = Object.values(AGENT_STATES);
    expect(new Set(states.map((s) => s.label)).size).toBe(states.length);
    expect(new Set(states.map((s) => s.Icon)).size).toBe(states.length);
  });

  test("should say what a send does now for each run state", () => {
    expect(waitingLabel({ reason: "permission", tool: "Bash" })).toBe("permission · Bash");
    expect(waitingLabel({ reason: "question", tool: null })).toBe("question");
    expect(sendOutcome({ streaming: false, steers: false, inbox: false })).toBeNull();
    expect(sendOutcome({ streaming: true, steers: true, inbox: false })).toBe(
      "Send steers the current turn.",
    );
    expect(sendOutcome({ streaming: true, steers: false, inbox: false })).toBe(
      "Send queues until the turn ends.",
    );
    expect(sendOutcome({ streaming: false, steers: false, inbox: true, waitingFor: null })).toBe(
      "Running in its own agent. Send queues your message for its next safe point.",
    );
    expect(
      sendOutcome({
        streaming: false,
        steers: false,
        inbox: true,
        waitingFor: { reason: "permission", tool: "Bash" },
      }),
    ).toBe("Needs you · permission · Bash. Send queues until it is answered.");
  });
});
