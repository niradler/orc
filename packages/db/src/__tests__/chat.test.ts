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
        config: { agent: "codex", system: "Private instructions" },
        runtimeId: "native-session",
        sourceId: "source-session",
        cwd: "/private",
        host: "remote-a",
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
        config: { agent: 42 },
        runtimeId: ["not-a-string"],
        sourceId: { id: "not-a-string" },
        host: 42,
      }),
    );
    const summaries = new ChatStore(db).list();
    expect(summaries).toEqual([
      {
        id: "current",
        title: "Current chat",
        updatedAt: 40,
        agent: "codex",
        runtimeId: "native-session",
        sourceId: "source-session",
        host: "remote-a",
      },
      {
        id: "legacy",
        title: "Legacy chat",
        updatedAt: 30,
        agent: null,
        runtimeId: null,
        sourceId: null,
        host: null,
      },
      {
        id: "corrupt",
        title: "Corrupt chat",
        updatedAt: 20,
        agent: null,
        runtimeId: null,
        sourceId: null,
        host: null,
      },
      {
        id: "wrong-types",
        title: "Wrong types",
        updatedAt: 10,
        agent: null,
        runtimeId: null,
        sourceId: null,
        host: null,
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("Private");
  } finally {
    db.close();
  }
});

test("chat summaries keep the newest100 limit when stored data is malformed", () => {
  const db = new Database(":memory:");
  installChat(db);
  try {
    const insert = db.query(
      "INSERT INTO chat_threads (id, title, updated_at, data) VALUES (?, ?, ?, ?)",
    );
    for (let index = 0; index < 105; index++)
      insert.run(`chat-${index}`, `Chat ${index}`, index, "not-json");
    const summaries = new ChatStore(db).list();
    expect(summaries).toHaveLength(100);
    expect(summaries[0]?.updatedAt).toBe(104);
    expect(summaries[99]?.updatedAt).toBe(5);
    expect(
      summaries.every(
        (summary) =>
          summary.agent === null &&
          summary.runtimeId === null &&
          summary.sourceId === null &&
          summary.host === null,
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
        runtimeId: "same-native-id",
        sourceId: null,
        host: "host-b",
      },
      {
        id: "chat-host-a",
        title: "host-a",
        updatedAt: 0,
        agent: "codex",
        runtimeId: "same-native-id",
        sourceId: null,
        host: "host-a",
      },
    ]);
  } finally {
    db.close();
  }
});
