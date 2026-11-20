import { describe, expect, test } from "bun:test";
import type { ChatActivity } from "@orc/core/chat";
import type { SessionStatus, SessionSubagents } from "@orc/core/session-messages";
import {
  backgroundActivity,
  backgroundSessions,
  backgroundSubagents,
  backgroundSummary,
  chatBackgroundWork,
} from "../../src/lib/chat-background";

const command: ChatActivity = {
  type: "tool",
  id: "c1",
  name: "Bash",
  input: JSON.stringify({ command: "bun test --watch", run_in_background: true }),
  result: "Command running in background with ID: bash_1",
  startedAt: 1_000,
  background: "command",
};

const subagent: ChatActivity = {
  type: "tool",
  id: "s1",
  name: "Task",
  input: JSON.stringify({ description: "Review the diff", run_in_background: true }),
  startedAt: 2_000,
  background: "subagent",
};

test("reported subagents replace detached subagent calls and only running branches stay", () => {
  const items = backgroundActivity([
    command,
    subagent,
    {
      type: "subagent",
      id: "outer",
      title: "Outer",
      status: "running",
      startedAt: 5,
      activity: [],
    },
    { type: "subagent", id: "inner", parentId: "outer", status: "waiting", activity: [] },
    { type: "subagent", id: "done", title: "Done", status: "completed", activity: [] },
  ]);
  expect(items.map((item) => [item.id, item.kind, item.status, item.label])).toEqual([
    ["c1", "command", "running", "bun test --watch"],
    ["outer", "subagent", "waiting", "Outer"],
  ]);
  expect(items[1]?.startedAt).toBe(5);
});

const session = (overrides: Partial<SessionStatus>): SessionStatus => ({
  session_id: "sess_1",
  title: "Reword the docs",
  agent: "codex",
  status: "running",
  waiting_for: null,
  last_message: null,
  queue: [],
  parent_session_id: "parent",
  children: [],
  working_children: 0,
  waiting_children: 0,
  stopping: false,
  project_id: null,
  cwd: "/repo",
  started_at: 5_000,
  updated_at: 6_000,
  ...overrides,
});

describe("backgroundActivity", () => {
  test("keeps only work the call left running", () => {
    const activity: ChatActivity[] = [
      command,
      subagent,
      { type: "tool", id: "t", name: "Read", input: "{}", result: "x" },
      { type: "thinking", id: "k", text: "hm" },
    ];
    expect(backgroundActivity(activity)).toEqual([
      { id: "c1", kind: "command", label: "bun test --watch", startedAt: 1_000, status: "running" },
      { id: "s1", kind: "subagent", label: "Review the diff", startedAt: 2_000, status: "running" },
    ]);
  });

  test("falls back to the tool name when a call says nothing more", () => {
    expect(
      backgroundActivity([
        {
          type: "tool",
          id: "x",
          name: "Task",
          input: JSON.stringify({ run_in_background: true }),
          background: "subagent",
        },
      ]),
    ).toEqual([{ id: "x", kind: "subagent", label: "Task", startedAt: null, status: "running" }]);
  });
});

describe("backgroundSessions", () => {
  test("keeps sessions that still owe work and opens chat children", () => {
    expect(
      backgroundSessions([
        session({}),
        session({ session_id: "sess_2", status: "waiting", title: "Approve the plan" }),
        session({ session_id: "sess_3", status: "idle" }),
        session({ session_id: "sess_4", status: "failed" }),
      ]),
    ).toEqual([
      {
        id: "sess_1",
        kind: "subagent",
        label: "Reword the docs",
        startedAt: 5_000,
        status: "running",
        sessionId: "sess_1",
      },
      {
        id: "sess_2",
        kind: "subagent",
        label: "Approve the plan",
        startedAt: 5_000,
        status: "waiting",
        sessionId: "sess_2",
      },
    ]);
  });
});

describe("chatBackgroundWork", () => {
  test("lists tool work before started sessions and drops duplicates", () => {
    const items = chatBackgroundWork([command], [session({ session_id: "c1" })]);
    expect(items.map((item) => item.id)).toEqual(["c1"]);
    expect(items[0]?.kind).toBe("command");
  });

  test("once the turn ends, subagent rows come from live queries, not the frozen transcript", () => {
    const items = chatBackgroundWork(
      [command, subagent],
      [session({})],
      [nativeSubagent({})],
      false,
    );
    expect(items.map((item) => item.id)).toEqual(["c1", "sess_1", "gw_1"]);
    expect(items[1]?.sessionId).toBe("sess_1");
    expect(items[2]?.native).toBe(true);
  });

  test("while streaming, transcript subagent calls still show alongside live children", () => {
    const items = chatBackgroundWork([command, subagent], [session({})], [], true);
    expect(items.map((item) => item.id)).toEqual(["c1", "s1", "sess_1"]);
  });
});

const nativeSubagent = (
  overrides: Partial<SessionSubagents["subagents"][number]>,
): SessionSubagents["subagents"][number] => ({
  id: "gw_1",
  parent_id: null,
  session_id: "native-1",
  title: "Review the diff",
  status: "running",
  tool_call_id: null,
  created_at: 7,
  ...overrides,
});

describe("backgroundSubagents", () => {
  test("keeps running native subagents with their own clock and a resumable link", () => {
    expect(
      backgroundSubagents([
        nativeSubagent({}),
        nativeSubagent({ id: "gw_2", status: "error" }),
        nativeSubagent({ id: "gw_3", status: "stopped" }),
      ]),
    ).toEqual([
      {
        id: "gw_1",
        kind: "subagent",
        label: "Review the diff",
        startedAt: 7_000,
        status: "running",
        sessionId: "gw_1",
        native: true,
      },
    ]);
  });
});

describe("backgroundSummary", () => {
  test("names one kind, then both", () => {
    const [one] = backgroundActivity([command]);
    const [two] = backgroundActivity([subagent]);
    expect(backgroundSummary([one as never])).toBe("Running 1 command");
    expect(backgroundSummary([one as never, two as never])).toBe(
      "Running 1 command and 1 subagent",
    );
  });
});
