import { afterEach, beforeEach, expect, test } from "bun:test";
import { ChatSettingsSchema, type ChatThread, ChatThreadSchema } from "@orc/core/chat";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import type { createApp } from "../server.js";
import { activeTurns, turnKey } from "../sessions/turns.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  app = setupTestApp();
});
afterEach(teardownTestApp);

function seedThread(overrides: Partial<ChatThread> = {}): ChatThread {
  const started = 1_700_000_000_000;
  const thread: ChatThread = {
    id: crypto.randomUUID(),
    title: "Refactor the chat panel",
    config: ChatSettingsSchema.parse({ agent: "codex", model: "fixture-model" }),
    cwd: "/workspace/orc",
    host: null,
    runtimeId: "native-session",
    backend: "codex-cli",
    sourceId: "source-session",
    transcriptMark: "123:456",
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        content: "Refactor the chat panel",
        timestamp: started,
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "The panel now copies and forks per message.",
        timestamp: started + 42_000,
        agent: "codex",
        turn: {
          startedAt: started,
          finishedAt: started + 42_000,
          durationMs: 42_000,
          outcome: "completed",
        },
      },
      {
        id: crypto.randomUUID(),
        role: "user",
        content: "Now add tests",
        timestamp: started + 60_000,
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "Tests added.",
        timestamp: started + 70_000,
        turn: {
          startedAt: started + 60_000,
          finishedAt: started + 70_000,
          durationMs: 10_000,
          outcome: "completed",
        },
      },
    ],
    updatedAt: started + 70_000,
    ...overrides,
  };
  new ChatStore(getSqlite()).save(thread);
  return thread;
}

test("a fork copies the prefix with fresh ids and no native session", async () => {
  const source = seedThread();
  const target = source.messages[1];
  if (!target) throw new Error("Missing assistant message");
  const response = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
    messageId: target.id,
  });
  expect(response.status).toBe(200);
  const forked = ChatThreadSchema.parse(await response.json());

  expect(forked.id).not.toBe(source.id);
  expect(forked.title).toBe("Refactor the chat panel (fork)");
  expect(forked.messages.map((message) => message.content)).toEqual(
    source.messages.slice(0, 2).map((message) => message.content),
  );
  expect(forked.messages.map((message) => message.id)).not.toEqual(
    source.messages.slice(0, 2).map((message) => message.id),
  );
  expect(new Set(forked.messages.map((message) => message.id)).size).toBe(2);
  expect(forked.messages[1]?.turn).toEqual(target.turn);
  expect(forked.runtimeId).toBeNull();
  expect(forked.sourceId).toBeNull();
  expect(forked.transcriptMark).toBeUndefined();
  expect(forked.historyBefore).toBeNull();
  expect(forked.importedMessages).toBe(2);
  expect(forked.forkedFrom).toEqual({ threadId: source.id, messageId: target.id });
  const normalized = ChatThreadSchema.parse(
    await (await req(app, "GET", `/chat/threads/${source.id}`)).json(),
  );
  expect(forked.config).toEqual(normalized.config);
  expect(forked.cwd).toBe(source.cwd);
  expect(forked.projectId).toBe(source.projectId);

  const stored = new ChatStore(getSqlite()).get(forked.id);
  expect(stored?.forkedFrom?.messageId).toBe(target.id);
  const original = new ChatStore(getSqlite()).get(source.id);
  expect(original?.messages).toHaveLength(4);
  expect(original?.runtimeId).toBe("native-session");
});

test("a fork keeps one suffix when forked again", async () => {
  const source = seedThread();
  const first = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
    messageId: source.messages[1]?.id,
  });
  const once = ChatThreadSchema.parse(await first.json());
  const second = await req(app, "POST", `/chat/threads/${once.id}/fork`, {
    messageId: once.messages[1]?.id,
  });
  expect(second.status).toBe(200);
  const twice = ChatThreadSchema.parse(await second.json());
  expect(twice.title).toBe("Refactor the chat panel (fork)");
  expect(twice.forkedFrom?.threadId).toBe(once.id);
});

test("a fork rejects a user message, an unknown message and an unknown thread", async () => {
  const source = seedThread();
  const user = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
    messageId: source.messages[0]?.id,
  });
  expect(user.status).toBe(400);

  const missingMessage = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
    messageId: crypto.randomUUID(),
  });
  expect(missingMessage.status).toBe(404);

  const missingThread = await req(app, "POST", `/chat/threads/${crypto.randomUUID()}/fork`, {
    messageId: source.messages[1]?.id,
  });
  expect(missingThread.status).toBe(404);
});

test("a fork waits for a running native turn", async () => {
  const source = seedThread();
  const key = turnKey(source.host, source.backend, source.runtimeId ?? "");
  activeTurns.add(key);
  try {
    const response = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
      messageId: source.messages[1]?.id,
    });
    expect(response.status).toBe(409);
  } finally {
    activeTurns.delete(key);
  }
});
