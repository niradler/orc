import { describe, expect, test } from "bun:test";
import type { HumanRequest } from "@orc/core/human-requests";
import type { OrcNotification } from "@orc/core/notifications";
import type { LiveSession } from "@orc/sdk/types";
import type { ChatPendingRequest } from "./snapshot.js";
import { composeSnapshot, sessionWaiting, sessionWorking, snapshotBodyEqual } from "./snapshot.js";

const NOW = 1_775_731_234_000;

function session(overrides: Partial<LiveSession> = {}): LiveSession {
  return {
    id: "s1",
    agent: "claude",
    session_id: "native-1",
    name: "Fix the tests",
    summary: null,
    tokens_used: 1000,
    tokens_estimated: false,
    cwd: "/repo",
    host: null,
    pid: 123,
    status: "idle",
    project_id: "p1",
    task: null,
    last_activity_at: new Date(NOW).toISOString(),
    created_at: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function approvalRequest(overrides: Partial<HumanRequest> = {}): HumanRequest {
  return {
    id: "req1",
    input: {
      origin: { session_id: "s1", backend: "claude", request_id: "native-req" },
      project_id: "p1",
      kind: "approval",
      title: "Approve Bash",
      prompt: "rm -rf /tmp/foo",
      choices: [],
      choice_descriptions: {},
      multi_select: false,
      notify: [],
      expires_in_seconds: 86400,
    },
    status: "pending",
    delivery_error: null,
    version: 1,
    response: null,
    created_at: NOW,
    expires_at: NOW + 86400_000,
    responded_at: null,
    delivered_at: null,
    seen_at: null,
    push_state: null,
    push_error: null,
    ...overrides,
  };
}

function notification(overrides: Partial<OrcNotification> = {}): OrcNotification {
  return {
    id: "n1",
    type: "agent.finished",
    source_id: "s1",
    title: "Agent finished",
    body: "",
    level: "done",
    project_id: "p1",
    path: "/activity",
    requires_action: false,
    created_at: NOW,
    expires_at: NOW + 86400_000,
    read_at: null,
    dismissed_at: null,
    ...overrides,
  };
}

const projects = [{ id: "p1", name: "orc" }];

function compose(overrides: Partial<Parameters<typeof composeSnapshot>[0]> = {}) {
  return composeSnapshot({
    now: NOW,
    sessions: [],
    notifications: [],
    humanRequests: [],
    chatPending: [],
    projects,
    unread: 0,
    tokensToday: null,
    ...overrides,
  });
}

describe("session state", () => {
  test("a parent with working children reads as working", () => {
    expect(sessionWorking(session({ status: "idle", working_children: 2 }))).toBe(true);
    expect(sessionWorking(session({ background_work: true }))).toBe(true);
    expect(sessionWorking(session())).toBe(false);
  });

  test("waiting rolls up children and waiting_for", () => {
    expect(sessionWaiting(session({ waiting_children: 1 }))).toBe(true);
    expect(sessionWaiting(session({ waiting_for: { reason: "permission", tool: "Bash" } }))).toBe(
      true,
    );
    expect(sessionWaiting(session())).toBe(false);
  });
});

describe("composeSnapshot", () => {
  test("empty fleet is idle", () => {
    const snapshot = compose();
    expect(snapshot.mood).toBe("idle");
    expect(snapshot.sessions).toEqual({ total: 0, working: 0, waiting: 0 });
    expect(snapshot.v).toBe(1);
  });

  test("running sessions make it busy", () => {
    const snapshot = compose({ sessions: [session({ status: "running" }), session({ id: "s2" })] });
    expect(snapshot.mood).toBe("busy");
    expect(snapshot.sessions).toEqual({ total: 2, working: 1, waiting: 0 });
  });

  test("a pending approval outranks busy and carries the project name", () => {
    const snapshot = compose({
      sessions: [session({ status: "running" })],
      humanRequests: [approvalRequest()],
    });
    expect(snapshot.mood).toBe("attention");
    expect(snapshot.needs_you[0]).toMatchObject({
      id: "req1",
      kind: "approval",
      title: "Approve Bash",
      hint: "rm -rf /tmp/foo",
      project: "orc",
      actionable: true,
    });
  });

  test("choice questions are actionable, free-text questions are not", () => {
    const choice = approvalRequest({
      id: "req2",
      input: { ...approvalRequest().input, kind: "question", choices: ["Yes", "No"] },
    });
    const freeText = approvalRequest({
      id: "req3",
      input: { ...approvalRequest().input, kind: "question", choices: [] },
    });
    const snapshot = compose({ humanRequests: [freeText, choice] });
    expect(snapshot.needs_you.map((item) => item.id)).toEqual(["req2", "req3"]);
    expect(snapshot.needs_you[0]?.choices).toEqual(["Yes", "No"]);
    expect(snapshot.needs_you[1]?.actionable).toBe(false);
  });

  test("chat permissions become actionable approvals with composite ids", () => {
    const pending: ChatPendingRequest = {
      runId: "run-1",
      requestId: "perm-1",
      threadId: "t1",
      kind: "approval",
      title: "Chat session",
      hint: "Bash: rm -rf /tmp/foo",
      projectId: "p1",
      choices: [],
      answerable: true,
    };
    const snapshot = compose({ chatPending: [pending] });
    expect(snapshot.needs_you[0]?.id).toBe("chat:run-1:perm-1");
    expect(snapshot.needs_you[0]?.actionable).toBe(true);
    expect(snapshot.mood).toBe("attention");
  });

  test("native waits are display-only and skipped when a request covers the session", () => {
    const waiting = session({ waiting_for: { reason: "permission", tool: "Bash" } });
    const uncovered = compose({ sessions: [waiting] });
    expect(uncovered.needs_you[0]).toMatchObject({ id: "native:s1", actionable: false });
    const covered = compose({ sessions: [waiting], humanRequests: [approvalRequest()] });
    expect(covered.needs_you.map((item) => item.id)).toEqual(["req1"]);
  });

  test("error sessions read as error when nothing needs you", () => {
    expect(compose({ sessions: [session({ status: "error" })] }).mood).toBe("error");
  });

  test("celebrate holds only until its deadline", () => {
    expect(compose({ celebrateUntil: NOW + 1000 }).mood).toBe("celebrate");
    expect(compose({ celebrateUntil: NOW - 1 }).mood).toBe("idle");
  });

  test("recent lines carry ids, unread flags and local time", () => {
    const snapshot = compose({
      notifications: [notification(), notification({ id: "n2", read_at: NOW })],
      unread: 1,
    });
    expect(snapshot.recent).toHaveLength(2);
    expect(snapshot.recent[0]?.id).toBe("n1");
    expect(snapshot.recent[0]?.unread).toBe(true);
    expect(snapshot.recent[1]?.unread).toBe(false);
    expect(snapshot.recent[0]?.line).toMatch(/^\d{2}:\d{2} Agent finished$/);
    expect(snapshot.unread).toBe(1);
  });

  test("snapshotBodyEqual ignores the timestamp", () => {
    const a = compose();
    const b = { ...a, t: a.t + 10 };
    expect(snapshotBodyEqual(a, b)).toBe(true);
    expect(snapshotBodyEqual(a, { ...b, unread: 3 })).toBe(false);
  });
});
