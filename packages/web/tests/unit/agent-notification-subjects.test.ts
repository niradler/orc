import { describe, expect, test } from "bun:test";
import type { HumanRequest } from "@orc/core/human-requests";
import type { LiveSession } from "../../src/api/client";
import {
  chatTabState,
  type NotifyChatTab,
  notifySubjects,
} from "../../src/lib/agent-notification-subjects";

const tab = (extra: Partial<NotifyChatTab> = {}): NotifyChatTab =>
  ({
    thread: { id: "thread-1", title: "Plan release", runtimeId: "native-1", host: null },
    config: { agent: "claude" },
    projectId: "p1",
    permissions: [],
    questions: [],
    error: null,
    streaming: false,
    attention: false,
    ...extra,
  }) as unknown as NotifyChatTab;

const request = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    version: 2,
    status: "pending",
    input: {
      kind: "approval",
      title: "Run migration",
      prompt: "Allow it?",
      project_id: "p1",
      action: { tool: "command" },
      origin: { backend: "codex", session_id: "native-9", execution_host: null },
      ...extra,
    },
  }) as unknown as HumanRequest;

const live = (status: string, waiting = false) =>
  ({
    id: "live-9",
    session_id: "native-9",
    agent: "codex",
    host: null,
    name: "Migrate billing",
    summary: null,
    status,
    waiting_for_human: waiting,
    project_id: "p1",
  }) as unknown as LiveSession;

const sources = (extra: Partial<Parameters<typeof notifySubjects>[0]>) => ({
  tabs: [],
  waits: [],
  requests: [],
  sessions: [],
  ...extra,
});

describe("chat tab state", () => {
  test("permissions outrank errors, errors outrank streaming", () => {
    expect(chatTabState(tab({ permissions: [{}] as never, error: "x" }))).toBe("needs-you");
    expect(chatTabState(tab({ error: "boom", streaming: true }))).toBe("failed");
    expect(chatTabState(tab({ streaming: true }))).toBe("working");
    expect(chatTabState(tab({ attention: true }))).toBe("done");
    expect(chatTabState(tab())).toBe("idle");
  });
});

describe("notifySubjects", () => {
  test("a request and its live session are one subject with an approval", () => {
    const [subject, ...rest] = notifySubjects(
      sources({ requests: [request("r1")], sessions: [live("running", true)] }),
    );
    expect(rest).toEqual([]);
    expect(subject).toMatchObject({
      state: "needs-you",
      title: "Migrate billing",
      agent: "codex",
      target: { kind: "attention" },
      approval: { id: "r1", version: 2 },
      liveIds: ["live-9"],
      detail: "Run migration",
    });
  });

  test("two pending requests on one session offer Open only", () => {
    const [subject] = notifySubjects(
      sources({ requests: [request("r1"), request("r2")], sessions: [live("running")] }),
    );
    expect(subject.state).toBe("needs-you");
    expect(subject.approval).toBeUndefined();
  });

  test("questions never carry an approval", () => {
    const [subject] = notifySubjects(sources({ requests: [request("q", { kind: "question" })] }));
    expect(subject.approval).toBeUndefined();
    expect(subject.target).toEqual({ kind: "attention" });
    expect(subject.title).toBe("codex session");
  });

  test("a chat tab and its native session merge under the chat key", () => {
    const subjects = notifySubjects(
      sources({
        tabs: [tab({ streaming: true })],
        sessions: [
          {
            ...live("running", true),
            agent: "claude-cli",
            session_id: "native-1",
          } as LiveSession,
        ],
      }),
    );
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toMatchObject({
      key: "chat:thread-1",
      state: "needs-you",
      target: { kind: "chat", threadId: "thread-1" },
    });
  });
});
