import { describe, expect, test } from "bun:test";
import {
  AGENT_STATE_ORDER,
  AGENT_STATES,
  liveSessionState,
  moreUrgent,
  rollupState,
  titleWithNeedsYou,
} from "../../src/lib/agent-state";

describe("agent state language", () => {
  test("should map every live session status to one shared state", () => {
    expect(liveSessionState({ status: "running", waiting_for_human: true })).toBe("needs-you");
    expect(liveSessionState({ status: "error" })).toBe("failed");
    expect(liveSessionState({ status: "running" })).toBe("working");
    expect(liveSessionState({ status: "idle" })).toBe("idle");
    expect(liveSessionState({ status: "stopped" })).toBe("ended");
  });

  test("should rank Needs you > Failed > Done > Working > Idle > Ended", () => {
    expect(AGENT_STATE_ORDER).toEqual(["needs-you", "failed", "done", "working", "idle", "ended"]);
    expect(moreUrgent("working", "needs-you")).toBe("needs-you");
    expect(moreUrgent("failed", "done")).toBe("failed");
    expect(moreUrgent("idle", "ended")).toBe("idle");
  });

  test("should roll a group up to its most urgent child and stay quiet when nothing happens", () => {
    expect(rollupState(["idle", "working", "failed"])).toBe("failed");
    expect(rollupState(["idle", "ended", null])).toBeNull();
    expect(rollupState([])).toBeNull();
  });

  test("should give each state a distinct word and icon so color is never the only signal", () => {
    const states = Object.values(AGENT_STATES);
    expect(new Set(states.map((s) => s.label)).size).toBe(states.length);
    expect(new Set(states.map((s) => s.Icon)).size).toBe(states.length);
  });

  test("should prefix the tab title with the Needs you count", () => {
    expect(titleWithNeedsYou("ORC", 2)).toBe("(2) ORC");
    expect(titleWithNeedsYou("ORC", 0)).toBe("ORC");
  });
});
