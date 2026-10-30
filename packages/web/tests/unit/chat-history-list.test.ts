import { expect, test } from "bun:test";
import type { ArchiveSession } from "@orc/core/session-archive";
import type { LiveSession } from "../../src/api/client";
import { chatHistoryList } from "../../src/lib/chat-history-list";

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
