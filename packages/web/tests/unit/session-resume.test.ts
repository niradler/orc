import { describe, expect, test } from "bun:test";
import type { LiveSession } from "../../src/api/client";
import {
  resumeCommand,
  resumeUnavailableReason,
  STATUS,
  scopedSessionPath,
} from "../../src/lib/live-sessions";

const session: LiveSession = {
  id: "row",
  agent: "claude",
  session_id: "session-id",
  cwd: null,
  host: null,
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
  test("should reject command injection in native IDs and quote directory names", () => {
    expect(resumeCommand({ ...session, session_id: "id; echo unsafe" })).toBeNull();
    expect(resumeCommand({ ...session, cwd: "/tmp/Nir's workspace" })).toBe(
      "cd '/tmp/Nir'\\''s workspace' && claude --resume session-id",
    );
    expect(resumeCommand({ ...session, cwd: "C:\\Nir's workspace" })).toBe(
      "Set-Location -LiteralPath 'C:\\Nir''s workspace'; claude --resume session-id",
    );
    expect(resumeCommand({ ...session, cwd: "\\\\?\\C:\\Projects\\orc" })).toBe(
      "Set-Location -LiteralPath 'C:\\Projects\\orc'; claude --resume session-id",
    );
  });
  test("should preserve project context in session, task and terminal links", () => {
    expect(scopedSessionPath("/sessions?session=abc", "my project")).toBe(
      "/sessions?session=abc&project=my+project",
    );
    expect(scopedSessionPath("/tasks/abc", null)).toBe("/tasks/abc");
    expect(scopedSessionPath("/terminals?session=abc&project=old", "all")).toBe(
      "/terminals?session=abc&project=all",
    );
  });
  test("should explain unavailable resume instead of silently hiding actions", () => {
    expect(resumeUnavailableReason({ ...session, session_id: null })).toContain(
      "No native session ID",
    );
    expect(resumeUnavailableReason({ ...session, agent: "cursor" })).toContain("Cursor IDE");
    expect(resumeUnavailableReason(session)).toBeNull();
  });
});
