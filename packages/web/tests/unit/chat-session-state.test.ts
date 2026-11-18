import { describe, expect, test } from "bun:test";
import { chatSessionState } from "../../src/lib/agent-state";

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

describe("chat header state", () => {
  test("an idle session stays idle", () => {
    expect(chatSessionState(base)).toBe("idle");
  });

  test("re-importing an idle session's transcript does not pop the working panel", () => {
    expect(chatSessionState({ ...base, refreshing: true, runClaim: false })).toBe("idle");
  });

  test("a rebuild while a turn is actually running still reads as working", () => {
    expect(chatSessionState({ ...base, refreshing: true, runClaim: true })).toBe("working");
  });

  test("a live stream reads as working", () => {
    expect(chatSessionState({ ...base, streaming: true })).toBe("working");
  });

  test("a turn running elsewhere reads as working", () => {
    expect(chatSessionState({ ...base, turnElsewhere: true })).toBe("working");
  });

  test("reconnecting reads as working", () => {
    expect(chatSessionState({ ...base, reconnecting: true })).toBe("working");
  });

  test("needs-you and failed take priority over a rebuild", () => {
    expect(chatSessionState({ ...base, refreshing: true, needsYou: true })).toBe("needs-you");
    expect(chatSessionState({ ...base, refreshing: true, failed: true })).toBe("failed");
  });

  test("no thread yields no state", () => {
    expect(chatSessionState({ ...base, hasThread: false })).toBeNull();
  });
});
