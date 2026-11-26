import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ChatStore, installChat } from "../chat.js";

test("chat summaries retain identity without exposing content and tolerate legacy or corrupt JSON", () => {
  const db = new Database(":memory:");
  installChat(db);
  const insert = db.query(
    "INSERT INTO chat_threads (id, title, updated_at, data) VALUES (?, ?, ?, ?)",
  );
  try {
    insert.run(
      "current",
      "Current chat",
      40,
      JSON.stringify({
        config: { agent: "codex", model: "default", system: "Private instructions" },
        runtimeId: "native-session",
        runtimeModel: "gpt-5.4",
        sourceId: "source-session",
        cwd: "/private",
        host: "remote-a",
        spawnedBy: { sessionId: "parent-chat", at: 1, notify: false },
        messages: [{ content: "Private message" }],
      }),
    );
    insert.run("legacy", "Legacy chat", 30, '{"host":null}');
    insert.run("corrupt", "Corrupt chat", 20, "{broken-json");
    insert.run(
      "wrong-types",
      "Wrong types",
      10,
      JSON.stringify({
        config: { agent: 42, model: 99 },
        runtimeId: ["not-a-string"],
        runtimeModel: { bad: true },
        sourceId: { id: "not-a-string" },
        host: 42,
        spawnedBy: { sessionId: 42 },
      }),
    );
    const summaries = new ChatStore(db).list();
    expect(summaries).toEqual([
      {
        id: "current",
        title: "Current chat",
        updatedAt: 40,
        agent: "codex",
        backend: null,
        runtimeId: "native-session",
        runtimeModel: "gpt-5.4",
        model: "default",
        sourceId: "source-session",
        host: "remote-a",
        projectId: null,
        spawnedFrom: "parent-chat",
        resumed: 0,
      },
      {
        id: "legacy",
        title: "Legacy chat",
        updatedAt: 30,
        agent: null,
        backend: null,
        runtimeId: null,
        runtimeModel: null,
        model: null,
        sourceId: null,
        host: null,
        projectId: null,
        spawnedFrom: null,
        resumed: 0,
      },
      {
        id: "corrupt",
        title: "Corrupt chat",
        updatedAt: 20,
        agent: null,
        backend: null,
        runtimeId: null,
        runtimeModel: null,
        model: null,
        sourceId: null,
        host: null,
        projectId: null,
        spawnedFrom: null,
        resumed: 0,
      },
      {
        id: "wrong-types",
        title: "Wrong types",
        updatedAt: 10,
        agent: null,
        backend: null,
        runtimeId: null,
        runtimeModel: null,
        model: null,
        sourceId: null,
        host: null,
        projectId: null,
        spawnedFrom: null,
        resumed: 0,
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("Private");
  } finally {
    db.close();
  }
});

test("chat summaries list every chat newest first when stored data is malformed", () => {
  const db = new Database(":memory:");
  installChat(db);
  try {
    const insert = db.query(
      "INSERT INTO chat_threads (id, title, updated_at, data) VALUES (?, ?, ?, ?)",
    );
    for (let index = 0; index < 105; index++)
      insert.run(`chat-${index}`, `Chat ${index}`, index, "not-json");
    const summaries = new ChatStore(db).list();
    expect(summaries).toHaveLength(105);
    expect(summaries[0]?.updatedAt).toBe(104);
    expect(summaries[104]?.updatedAt).toBe(0);
    expect(
      summaries.every(
        (summary) =>
          summary.agent === null &&
          summary.runtimeId === null &&
          summary.sourceId === null &&
          summary.host === null &&
          summary.projectId === null,
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});

test("chat summaries retain host identity for equal runtime IDs on different execution hosts", () => {
  const db = new Database(":memory:");
  installChat(db);
  try {
    const insert = db.query(
      "INSERT INTO chat_threads (id, title, updated_at, data) VALUES (?, ?, ?, ?)",
    );
    for (const [index, host] of ["host-a", "host-b"].entries()) {
      insert.run(
        `chat-${host}`,
        host,
        index,
        JSON.stringify({
          config: { agent: "codex" },
          runtimeId: "same-native-id",
          sourceId: null,
          host,
        }),
      );
    }
    expect(new ChatStore(db).list()).toEqual([
      {
        id: "chat-host-b",
        title: "host-b",
        updatedAt: 1,
        agent: "codex",
        backend: null,
        runtimeId: "same-native-id",
        runtimeModel: null,
        model: null,
        sourceId: null,
        host: "host-b",
        projectId: null,
        spawnedFrom: null,
        resumed: 0,
      },
      {
        id: "chat-host-a",
        title: "host-a",
        updatedAt: 0,
        agent: "codex",
        backend: null,
        runtimeId: "same-native-id",
        runtimeModel: null,
        model: null,
        sourceId: null,
        host: "host-a",
        projectId: null,
        spawnedFrom: null,
        resumed: 0,
      },
    ]);
  } finally {
    db.close();
  }
});

test("chat summaries expose project but not the working folder", () => {
  const db = new Database(":memory:");
  installChat(db);
  try {
    const insert = db.query(
      "INSERT INTO chat_threads (id, title, updated_at, data) VALUES (?, ?, ?, ?)",
    );
    insert.run(
      "assigned",
      "Assigned chat",
      2,
      JSON.stringify({
        config: { agent: "codex" },
        projectId: "proj-shop",
        spawnedFrom: null,
        resumed: 0,
        cwd: "/srv/shop",
        messages: [{ content: "Private message" }],
      }),
    );
    insert.run(
      "unassigned",
      "Unassigned chat",
      1,
      JSON.stringify({ config: { agent: "codex" }, cwd: "/srv/scratch" }),
    );
    const summaries = new ChatStore(db).list();
    expect(summaries).toEqual([
      {
        id: "assigned",
        title: "Assigned chat",
        updatedAt: 2,
        agent: "codex",
        backend: null,
        runtimeId: null,
        runtimeModel: null,
        model: null,
        sourceId: null,
        host: null,
        projectId: "proj-shop",
        spawnedFrom: null,
        resumed: 0,
      },
      {
        id: "unassigned",
        title: "Unassigned chat",
        updatedAt: 1,
        agent: "codex",
        backend: null,
        runtimeId: null,
        runtimeModel: null,
        model: null,
        sourceId: null,
        host: null,
        projectId: null,
        spawnedFrom: null,
        resumed: 0,
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("Private");
    expect(JSON.stringify(summaries)).not.toContain("/srv/");
  } finally {
    db.close();
  }
});

test("related session ids reach a subagent's parent and the chats that show either session", () => {
  const db = new Database(":memory:");
  installChat(db);
  db.exec(
    "CREATE TABLE gateway_sessions (id TEXT PRIMARY KEY, backend TEXT, runtime_session_id TEXT, parent_session_id TEXT, execution_host TEXT, transcript_path TEXT)",
  );
  const row = db.query("INSERT INTO gateway_sessions VALUES (?, ?, ?, ?, NULL, ?)");
  const thread = db.query(
    "INSERT INTO chat_threads (id, title, updated_at, data) VALUES (?, 'Chat', 1, ?)",
  );
  try {
    row.run("parent", "codex", "parent-native", null, null);
    row.run("child", "codex", "agent-child", "parent-native", "/t/child.jsonl");
    row.run("nested", "codex", "agent-nested", "agent-child", null);
    row.run("other", "claude", "parent-native", null, null);
    thread.run("parent-chat", JSON.stringify({ backend: "codex-cli", runtimeId: "parent-native" }));
    thread.run("child-chat", JSON.stringify({ sourceId: "child" }));
    thread.run("unrelated", JSON.stringify({ backend: "codex-cli", runtimeId: "elsewhere" }));
    const store = new ChatStore(db);
    expect(new Set(store.relatedSessionIds([], ["/t/child.jsonl"]))).toEqual(
      new Set(["child", "agent-child", "parent-native", "parent", "parent-chat", "child-chat"]),
    );
    expect(new Set(store.relatedSessionIds(["nested"], []))).toEqual(
      new Set(["nested", "agent-nested", "agent-child", "child", "parent-native", "child-chat"]),
    );
  } finally {
    db.close();
  }
});
