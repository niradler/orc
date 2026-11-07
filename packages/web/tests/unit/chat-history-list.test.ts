import { expect, test } from "bun:test";
import type { ArchiveSession } from "@orc/core/session-archive";
import type { LiveSession, Terminal } from "../../src/api/client";
import { chatHistoryList, historyEntryState } from "../../src/lib/chat-history-list";

const saved = {
  id: "90000000-0000-4000-8000-000000000001",
  title: "Saved alias",
  updatedAt: 1,
  running: false,
  agent: "codex",
  runtimeId: "native-runtime",
  host: null,
  sourceId: "live-source",
};
const live: LiveSession = {
  id: "live-source",
  session_id: "native-runtime",
  name: "Native alias",
  agent: "codex",
  summary: null,
  tokens_used: null,
  tokens_estimated: false,
  cwd: null,
  host: null,
  pid: null,
  status: "stopped",
  project_id: "project-a",
  task: null,
  created_at: "2026-10-30T00:00:00Z",
  last_activity_at: "2026-10-30T00:00:00Z",
};
const archive: ArchiveSession = {
  id: "archive-source",
  native_id: "native-runtime",
  agent: "codex",
  project_id: "project-b",
  source_id: "source",
  title: "Archive alias",
  metadata: { subdirectory: "" },
  revision: 1,
  content_hash: "hash",
  index_revision: 1,
  embedding_error: null,
  created_at: "2026-10-30T00:00:00Z",
  updated_at: "2026-10-30T00:00:01Z",
};

test("should merge Cursor CLI aliases without merging Cursor IDE archives", () => {
  const entries = chatHistoryList(
    [],
    [{ ...saved, agent: "cursor", sourceId: null }],
    [{ ...live, agent: "cursor-agent" }],
    [
      { ...archive, agent: "cursor-agent" },
      { ...archive, id: "ide", agent: "cursor" },
    ],
  );
  expect(entries).toHaveLength(2);
  expect(entries.some((entry) => entry.id === "archive:ide")).toBe(true);
  expect(entries.some((entry) => entry.id === `chat:${saved.id}`)).toBe(true);
});

test("archive project metadata cannot overwrite an authoritative native association", () => {
  for (const archiveProject of ["project-b", null]) {
    const entries = chatHistoryList(
      [],
      [saved],
      [live],
      [{ ...archive, project_id: archiveProject }],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].projectId).toBe("project-a");
    expect(
      chatHistoryList(
        [],
        [saved],
        [live],
        [{ ...archive, project_id: archiveProject }],
        "",
        "project-a",
      ),
    ).toHaveLength(1);
    expect(
      chatHistoryList(
        [],
        [saved],
        [live],
        [{ ...archive, project_id: archiveProject }],
        "",
        "unassigned",
      ),
    ).toHaveLength(0);
  }
});

test("unknown saved ownership is accessible in All and never guessed to be Unassigned", () => {
  expect(chatHistoryList([], [saved], [], [], "", "all")).toHaveLength(1);
  expect(chatHistoryList([], [saved], [], [], "", "unassigned")).toHaveLength(0);
  expect(chatHistoryList([], [saved], [], [], "", "project-a")).toHaveLength(0);
});

test("only explicit null sources belong to Unassigned while aliases stay deduplicated", () => {
  const entries = chatHistoryList(
    [],
    [saved],
    [{ ...live, project_id: null }],
    [archive],
    "",
    "unassigned",
  );
  expect(entries).toHaveLength(1);
  expect(entries[0].id).toBe(`chat:${saved.id}`);
  expect(entries[0].projectId).toBeNull();
});

test("a merged native session is seen through any of its aliases and reads Done until then", () => {
  const [entry] = chatHistoryList([], [saved], [{ ...live, status: "idle" }], []);
  expect(entry.seenKeys).toEqual([`chat:${saved.id}`, "native:live-source"]);
  const finished = entry.updatedAt;
  expect(historyEntryState(entry, { since: finished - 1, seen: {} })).toBe("done");
  expect(
    historyEntryState(entry, { since: finished - 1, seen: { "native:live-source": finished } }),
  ).toBe("idle");
  expect(historyEntryState(entry, { since: finished + 1, seen: {} })).toBe("idle");
  expect(historyEntryState(entry, { since: finished - 1, seen: {} }, true)).toBe("idle");
});

test("unseen Done never hides a session that needs you or is working", () => {
  const waiting = chatHistoryList(
    [],
    [],
    [{ ...live, status: "running", waiting_for_human: true }],
    [],
  )[0];
  const working = chatHistoryList([], [], [{ ...live, status: "running" }], [])[0];
  const empty = { since: 0, seen: {} };
  expect(historyEntryState(waiting, empty)).toBe("needs-you");
  expect(historyEntryState(working, empty)).toBe("working");
});

const terminal: Terminal = {
  id: "term-1",
  name: "claude · repo",
  kind: "claude",
  cwd: "/repo",
  status: "running",
  exit_code: null,
  pid: 1,
  live_session_id: null,
  host: null,
  created_at: "2026-10-30T00:00:02Z",
};

test("an agent running in an ORC terminal joins the list once and shell terminals stay out", () => {
  const linked = { ...terminal, live_session_id: live.id };
  const entries = chatHistoryList([], [], [live], [], "", "all", [
    linked,
    { ...terminal, id: "term-2", kind: "shell" },
    { ...terminal, id: "term-3", status: "exited" },
  ]);
  expect(entries).toHaveLength(1);
  expect(entries[0].terminalId).toBe("term-1");

  const [own] = chatHistoryList([], [], [], [], "", "all", [terminal]);
  expect(own.id).toBe("terminal:term-1");
  expect(own.kind === "terminal" && own.terminal).toBe(terminal);
  expect(own.terminalId).toBe("term-1");
  expect(historyEntryState(own, { since: 0, seen: {} })).toBe("unknown");
  expect(chatHistoryList([], [], [], [], "", "project-a", [terminal])).toHaveLength(0);
  expect(chatHistoryList([], [], [], [], "claude", "all", [terminal])).toHaveLength(1);
  expect(chatHistoryList([], [], [], [], "nomatch", "all", [terminal])).toHaveLength(0);
});
