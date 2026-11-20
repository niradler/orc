import { describe, expect, test } from "bun:test";
import {
  AGENT_STATE_ORDER,
  AGENT_STATES,
  chatSessionState,
  liveSessionState,
  moreUrgent,
  pendingLabel,
  rollupState,
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

  test("an idle parent whose children still work reads as working, not idle", () => {
    expect(liveSessionState({ status: "idle", working_children: 2 })).toBe("working");
    expect(liveSessionState({ status: "idle", working_children: 0 })).toBe("idle");
    // A child parked on a human needs the human through its parent too.
    expect(liveSessionState({ status: "idle", waiting_children: 1 })).toBe("needs-you");
    expect(liveSessionState({ status: "running", waiting_children: 1 })).toBe("needs-you");
    // A failed or ended parent keeps its own state; children have their own rows.
    expect(liveSessionState({ status: "error", working_children: 2 })).toBe("failed");
    expect(liveSessionState({ status: "stopped", working_children: 2 })).toBe("ended");
  });

  test("chat state rolls child work up without a live turn", () => {
    const base = {
      needsYou: false,
      failed: false,
      streaming: false,
      reconnecting: false,
      refreshing: false,
      turnElsewhere: false,
      runClaim: false,
      hasThread: true,
    };
    expect(chatSessionState(base)).toBe("idle");
    expect(chatSessionState({ ...base, workingChildren: 1 })).toBe("working");
    expect(chatSessionState({ ...base, waitingChildren: 1 })).toBe("needs-you");
    expect(chatSessionState({ ...base, failed: true, workingChildren: 1 })).toBe("failed");
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

  test("should name a wait by its reason and short tool name", () => {
    expect(waitingLabel({ reason: "permission", tool: "Bash" })).toBe("permission · Bash");
    expect(waitingLabel({ reason: "question", tool: null })).toBe("question");
    expect(
      waitingLabel({
        reason: "permission",
        tool: "mcp__claude_ai_ClickUp__clickup_get_bulk_tasks_time_in_status",
      }),
    ).toBe("permission · clickup_get_bulk_tasks_time_in_status");
    expect(pendingLabel({ reason: "permission", tool: "Bash" })).toBe(
      "Bash permission pending · sends queue",
    );
    expect(pendingLabel({ reason: "dialog", tool: null })).toBe("dialog pending · sends queue");
  });
});
