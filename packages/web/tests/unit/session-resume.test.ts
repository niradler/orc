import { describe, expect, test } from "bun:test";
import type { LiveSession } from "../../src/api/client";
import { resumeCommand, STATUS } from "../../src/lib/live-sessions";

const session: LiveSession = {
  id: "row",
  agent: "claude",
  session_id: "session-id",
  cwd: null,
  name: "Test",
  summary: null,
  status: "idle",
  pid: null,
  tokens_used: null,
  tokens_estimated: false,
  project_id: null,
  task: null,
  last_activity_at: null,
  created_at: new Date(0).toISOString(),
};

describe("agent session actions", () => {
  test.each([
    ["claude", "claude --resume session-id"],
    ["codex", "codex resume session-id"],
    ["cursor-agent", "agent --resume session-id"],
    ["gemini", "gemini --resume session-id"],
  ])("should offer the native resume command for %s", (agent, command) => {
    expect(resumeCommand({ ...session, agent: agent as string })).toBe(command);
    expect(resumeCommand({ ...session, agent: agent as string, session_id: null })).toBeNull();
  });
  test("should use the same status labels for every agent", () => {
    expect(STATUS.running.label).toBe("working");
    expect(STATUS.idle.label).toBe("waiting for you");
    expect(STATUS.stopped.label).toBe("ended");
  });
  test("should not pretend a Cursor IDE chat can resume through the separate CLI store", () => {
    expect(resumeCommand({ ...session, agent: "cursor" })).toBeNull();
  });
});
