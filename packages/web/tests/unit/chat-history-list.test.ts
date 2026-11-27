import { expect, test } from "bun:test";
import type { ArchiveSession } from "@orc/core/session-archive";
import type { LiveSession, Terminal } from "../../src/api/client";
import {
  chatHistoryList,
  folderLabel,
  folderProjectName,
  historyEntryState,
  nestedLabel,
  sessionModeLabel,
  sessionModelName,
  withDescendants,
} from "../../src/lib/chat-history-list";

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
  // The saved chat keeps the row; the discovered Cursor CLI session aliases it.
  expect(entries.some((entry) => entry.id === `chat:${saved.id}`)).toBe(true);
});

test("every discovered provider appears in the chat history, including Cursor", () => {
  for (const agent of ["claude", "codex", "gemini", "opencode", "pi", "cursor", "cursor-agent"]) {
    const rows = chatHistoryList([], [], [{ ...live, agent }], []);
    expect(rows.map((row) => row.id)).toEqual(["native:live-source"]);
  }
});

test("content-search hits keep their snippets and matched fields", () => {
  const hit = {
    ...live,
    snippets: ["the phrase inside the transcript"],
    matched: ["transcript"],
    score: 2,
  };
  const [entry] = chatHistoryList([], [], [hit], []);
  expect(entry.snippets).toEqual(["the phrase inside the transcript"]);
  expect(entry.matched).toEqual(["transcript"]);
  // A transcript-only hit survives the keyword filter that would drop its title.
  expect(chatHistoryList([], [], [hit], [], "phrase", "all")).toHaveLength(1);
  expect(
    chatHistoryList([], [], [{ ...live, snippets: [], matched: [] }], [], "phrase"),
  ).toHaveLength(0);
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

test("a saved chat whose children work reads Working, and a waiting child reads Needs you", () => {
  const own = { ...saved, sourceId: null };
  const empty = { since: 0, seen: {} };
  const [idle] = chatHistoryList([], [own], [], []);
  const [working] = chatHistoryList([], [{ ...own, workingChildren: 2 }], [], []);
  const [waiting] = chatHistoryList([], [{ ...own, waitingChildren: 1 }], [], []);
  expect(historyEntryState(idle, empty, true)).toBe("idle");
  expect(historyEntryState(working, empty, true)).toBe("working");
  expect(historyEntryState(waiting, empty, true)).toBe("needs-you");
  // A native parent rolls up the same way through the shared live state.
  const [native] = chatHistoryList([], [], [{ ...live, status: "idle", working_children: 1 }], []);
  expect(historyEntryState(native, empty, true)).toBe("working");
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

test("folder scopes place native aliases under their project before filtering, and plain shells stay out", () => {
  const projects = [{ id: "orc", scope: "C:/Projects/orc" }];
  const native = { ...live, project_id: null, cwd: "C:\\projects\\ORC\\packages\\web" };
  const shell = { ...terminal, kind: "shell", cwd: "c:/Projects/orc" };
  const rows = chatHistoryList([], [saved], [native], [], "", "orc", [shell], projects);
  expect(rows).toHaveLength(1);
  expect(rows.map((row) => row.projectId)).toEqual(["orc"]);
  expect(rows.some((row) => row.terminalId === shell.id)).toBe(false);
  expect(rows.some((row) => row.id === `chat:${saved.id}`)).toBe(true);
  expect(
    chatHistoryList([], [], [{ ...native, project_id: "assigned" }], [], "", "orc", [], projects),
  ).toHaveLength(0);
  expect(
    chatHistoryList(
      [],
      [],
      [],
      [],
      "",
      "orc",
      [{ ...shell, cwd: "C:/Projects/orchestra" }],
      projects,
    ),
  ).toHaveLength(0);
});

test("recency follows the conversation date: opening keeps its place, a new message moves it up", () => {
  const older = {
    ...live,
    id: "live-older",
    session_id: "runtime-older",
    project_id: null,
    created_at: "2026-10-29T00:00:00Z",
    last_activity_at: "2026-10-30T00:00:00Z",
  };
  const newer = {
    ...live,
    id: "live-newer",
    session_id: "runtime-newer",
    project_id: null,
    created_at: "2026-10-29T00:00:00Z",
    last_activity_at: "2026-10-30T01:00:00Z",
  };
  // A resumed thread carries the native session's activity date, not the open time.
  const resumed = {
    ...saved,
    id: "90000000-0000-4000-8000-000000000002",
    sourceId: "live-older",
    runtimeId: "runtime-older",
    updatedAt: Date.parse(older.last_activity_at),
  };
  const opened = chatHistoryList([], [resumed], [older, newer], []);
  expect(opened.map((entry) => entry.id)).toEqual(["native:live-newer", `chat:${resumed.id}`]);
  // Sending a message bumps the conversation date and moves it to the top.
  const sent = { ...resumed, updatedAt: Date.parse("2026-10-30T02:00:00Z") };
  const afterSend = chatHistoryList([], [sent], [older, newer], []);
  expect(afterSend.map((entry) => entry.id)).toEqual([`chat:${resumed.id}`, "native:live-newer"]);
});

test("saved chats keep their recorded project after reload", () => {
  const projects = [{ id: "shop", scope: "C:/Projects/shop" }];
  const assigned = {
    ...saved,
    id: "90000000-0000-4000-8000-000000000010",
    sourceId: null,
    runtimeId: null,
    projectId: "shop",
  };
  expect(
    chatHistoryList([], [assigned], [], [], "", "shop", [], false, projects).map(
      (entry) => entry.projectId,
    ),
  ).toEqual(["shop"]);
  expect(chatHistoryList([], [assigned], [], [], "", "unassigned")).toHaveLength(0);
  expect(chatHistoryList([], [assigned], [], [], "", "all")).toHaveLength(1);
});

test("a folder's project name is a valid, unused slug", () => {
  expect(folderProjectName("/Users/nir/projects/nebius-ai-cloud-sft", [])).toBe(
    "nebius-ai-cloud-sft",
  );
  expect(folderProjectName("/srv/shop/api", ["API"])).toBe("shop-api");
  expect(folderProjectName("/srv/shop/api", ["api", "shop-api"])).toBe("api-2");
  expect(folderProjectName("C:\\Users\\Nir\\My Repo (old)\\", [])).toBe("My-Repo-old");
  expect(folderProjectName("/", [])).toBe("project");
  expect(folderProjectName(`/x/${"a".repeat(300)}`, [])).toHaveLength(90);
});

test("subagent sessions stay out of the list but lift their parent's state and recency", () => {
  const parent = {
    ...live,
    id: "parent",
    session_id: "p",
    name: "Review the PR",
    project_id: null,
  };
  const child = {
    ...live,
    id: "child",
    session_id: "c",
    parent_id: "parent",
    name: "Find callers",
    status: "running" as const,
    project_id: null,
    last_activity_at: "2026-10-31T00:00:00Z",
  };
  const orphan = { ...live, id: "orphan", session_id: "o", parent_id: "gone", project_id: null };
  const entries = chatHistoryList([], [], [child, parent, orphan], []);
  expect(entries.map((entry) => entry.id)).toEqual(["native:parent", "native:orphan"]);
  const [top] = entries;
  expect(top?.children).toBeUndefined();
  expect(top?.subagents).toBe(1);
  expect(entries[1]?.subagents).toBeUndefined();
  expect(top?.observedState).toBe("working");
  expect(top?.updatedAt).toBe(Date.parse("2026-10-31T00:00:00Z"));
  expect(top?.seenKeys).toContain("native:child");
  expect(chatHistoryList([], [], [child, parent], [], "callers").map((e) => e.id)).toEqual([
    "native:parent",
  ]);
});

test("a failed grandchild subagent marks the top session Needs you", () => {
  const parent = { ...live, id: "parent", session_id: "p", status: "idle" as const };
  const child = {
    ...live,
    id: "child",
    session_id: "c",
    parent_id: "parent",
    status: "idle" as const,
  };
  const grandchild = {
    ...live,
    id: "grandchild",
    session_id: "g",
    parent_id: "child",
    status: "error" as const,
  };
  const entries = chatHistoryList([], [], [grandchild, child, parent], [], "", "all");
  expect(entries.map((entry) => entry.id)).toEqual(["native:parent"]);
  expect(entries[0]?.observedState).toBe("needs-you");
  const healthy = chatHistoryList(
    [],
    [],
    [{ ...grandchild, status: "idle" as const }, child, parent],
    [],
  );
  expect(healthy[0]?.observedState).toBe("idle");
});

test("an ORC chat whose last turn has a failed or waiting subagent needs you", () => {
  const tab = (status: "failed" | "waiting" | "completed") =>
    ({
      key: `tab-${status}`,
      thread: { id: `thread-${status}`, title: status, updatedAt: 1 },
      config: { agent: "claude" },
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "",
          activity: [
            { type: "subagent", id: "outer", status: "completed", activity: [] },
            { type: "subagent", id: "inner", parentId: "outer", status, activity: [] },
          ],
        },
      ],
      draft: "",
      files: [],
      queued: [],
      streaming: false,
      error: null,
      permissions: [],
      questions: [],
      activity: [],
    }) as unknown as Parameters<typeof chatHistoryList>[0][number];
  const entries = chatHistoryList([tab("failed"), tab("waiting"), tab("completed")], [], [], []);
  const state = (id: string) => entries.find((entry) => entry.id === id)?.observedState;
  expect(state("chat:thread-failed")).toBe("needs-you");
  expect(state("chat:thread-waiting")).toBe("needs-you");
  expect(state("chat:thread-completed")).toBeUndefined();
});

test("a subagent opened as a chat stays out of the list", () => {
  const parent = { ...live, id: "parent", session_id: "p", project_id: null };
  const child = { ...live, id: "child", session_id: "c", parent_id: "parent", project_id: null };
  const opened = { ...saved, id: "90000000-0000-4000-8000-000000000002", sourceId: "child" };
  const entries = chatHistoryList([], [opened], [child, parent], []);
  expect(entries.map((entry) => entry.id)).toEqual(["native:parent"]);
  expect(entries[0]?.children).toBeUndefined();
});

test("independent sessions nest under the session that started them, in a tree", () => {
  const root = { ...live, id: "root", session_id: "r", name: "SFT training", project_id: null };
  const child = {
    ...live,
    id: "child",
    session_id: "c",
    spawned_from_id: "root",
    name: "Dataset v3",
    project_id: null,
  };
  const grand = {
    ...live,
    id: "grand",
    session_id: "g",
    spawned_from_id: "child",
    name: "Benchmark baselines",
    status: "running" as const,
    project_id: null,
    last_activity_at: "2026-11-01T00:00:00Z",
  };
  const subagent = { ...live, id: "sub", session_id: "s", parent_id: "root", project_id: null };
  const orcSpawn = {
    ...saved,
    id: "90000000-0000-4000-8000-000000000003",
    title: "Spawned through ORC",
    agent: "claude",
    runtimeId: "orc-run",
    sourceId: null,
    spawnedFrom: "root",
  };
  const entries = chatHistoryList([], [orcSpawn], [grand, child, root, subagent], []);
  expect(entries.map((entry) => entry.id)).toEqual(["native:root"]);
  const [top] = entries;
  expect(top?.children?.map((entry) => [entry.id, !!entry.spawned])).toEqual([
    ["native:child", true],
    [`chat:${orcSpawn.id}`, true],
  ]);
  expect(top?.children?.[0]?.children?.map((entry) => entry.id)).toEqual(["native:grand"]);
  expect(top?.observedState).toBe("working");
  expect(top?.updatedAt).toBe(Date.parse("2026-11-01T00:00:00Z"));
  expect(nestedLabel(top?.children ?? [])).toBe("2 sessions");
  expect(withDescendants(top as NonNullable<typeof top>).map((entry) => entry.id)).toContain(
    "native:grand",
  );
  expect(chatHistoryList([], [], [grand, child, root], [], "baselines").map((e) => e.id)).toEqual([
    "native:root",
  ]);
  const loop = [
    { ...root, spawned_from_id: "child" },
    { ...child, spawned_from_id: "root" },
  ];
  expect(chatHistoryList([], [], loop, []).map((entry) => entry.id)).toHaveLength(1);
});

test("folder groups with the same name show enough of the path to tell them apart", () => {
  const folders = ["/tmp/a/e330/repo", "/tmp/a/e330b/repo", "/Users/nir/orc", null];
  expect(folders.map((cwd) => folderLabel(cwd, folders))).toEqual([
    "e330/repo",
    "e330b/repo",
    "orc",
    "Unassigned",
  ]);
  expect(folderLabel("/work/agentops", ["/work/agentops"], ["agentops"])).toBe("work/agentops");
});

test("an open tab older than its saved thread still merges the native session and takes its title", () => {
  const thread = { ...saved, title: "Coding agent competition framework", updatedAt: 5 };
  const tab = {
    key: "tab-1",
    projectId: null,
    config: { agent: "codex" },
    thread: { id: saved.id, title: "finish the post and lets merge the pr", updatedAt: 1 },
    messages: [],
    draft: "",
    files: [],
    queued: [],
    permissions: [],
    questions: [],
  } as unknown as Parameters<typeof chatHistoryList>[0][number];
  const entries = chatHistoryList([tab], [thread], [live], []);
  expect(entries.map((entry) => [entry.id, entry.title])).toEqual([
    [`chat:${saved.id}`, "Coding agent competition framework"],
  ]);
});

test("a chat stays in the project it was started in when its session's folder maps elsewhere", () => {
  const thread = { ...saved, projectId: "project-chat" };
  const session = { ...live, project_id: "project-folder" };
  const [entry] = chatHistoryList([], [thread], [session], []);
  expect(entry?.projectId).toBe("project-chat");
  expect(chatHistoryList([], [thread], [session], [], "", "project-folder")).toEqual([]);
});

test("a live session shows a short model name and a readable permission mode", () => {
  const entry = (session: Partial<LiveSession>) =>
    ({ kind: "native", session: { ...live, ...session } }) as Parameters<
      typeof sessionModelName
    >[0];
  expect(sessionModelName(entry({ model: "claude-opus-5-5" }))).toBe("Opus 5.5");
  expect(sessionModelName(entry({ model: "gpt-6.1-terra" }))).toBe("GPT-6.1 Terra");
  expect(sessionModelName(entry({}))).toBe("");
  expect(sessionModeLabel("acceptEdits")).toBe("Allow edits");
  expect(sessionModeLabel("bypassPermissions")).toBe("Full access");
  expect(sessionModeLabel("plan")).toBe("Plan");
  expect(sessionModeLabel("build")).toBe("Build");
  expect(sessionModeLabel("never/danger-full-access")).toBe("Full access");
  expect(sessionModeLabel("on-request/workspace-write")).toBe("Workspace write");
  expect(sessionModeLabel("never/read-only")).toBe("Read only");
  expect(sessionModeLabel("custom")).toBe("custom");
});

test("saved and local chat sessions prefer observed runtimeModel over configured alias", () => {
  const savedEntry = {
    kind: "saved",
    thread: { ...saved, model: "opus", runtimeModel: "qwen4-max" },
  } as Parameters<typeof sessionModelName>[0];
  expect(sessionModelName(savedEntry)).toBe("Qwen4 Max");

  const localEntry = {
    kind: "local",
    tab: {
      config: { model: "default" },
      thread: { runtimeModel: "qwen4-max" },
    },
  } as unknown as Parameters<typeof sessionModelName>[0];
  expect(sessionModelName(localEntry)).toBe("Qwen4 Max");
});
