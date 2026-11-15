import { afterAll, beforeAll, expect, test } from "bun:test";
import { ChatThreadSchema } from "@orc/core/chat";
import { ChatStore } from "@orc/db/chat";
import { getDb, getSqlite } from "@orc/db/client";
import { bridge_chats, gateway_sessions } from "@orc/db/schema";
import { LIVE_CHAT_ID } from "../session-watcher";
import { req, setupTestApp, teardownTestApp } from "./helpers";

let app: ReturnType<typeof setupTestApp>;
const linked = "11111111-1111-4111-8111-111111111111";
const orphan = "22222222-2222-4222-8222-222222222222";
const byMessage = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";

beforeAll(() => {
  app = setupTestApp();
  getDb()
    .insert(bridge_chats)
    .values({ id: LIVE_CHAT_ID, platform: "telegram", chat_id: "fixture" })
    .onConflictDoNothing()
    .run();
  getDb()
    .insert(gateway_sessions)
    .values({
      id: "discovered-opencode",
      chat_id: LIVE_CHAT_ID,
      backend: "opencode",
      mode: "direct",
      status: "idle",
      runtime_session_id: "ses_fixture",
      cwd: "/tmp",
    })
    .run();
  const store = new ChatStore(getSqlite());
  store.save(
    ChatThreadSchema.parse({
      id: byMessage,
      title: "Deep linked chat",
      config: { agent: "opencode" },
      cwd: "/tmp",
      host: null,
      runtimeId: "ses_fixture",
      sourceId: null,
      backend: "opencode",
      messages: [{ id: messageId, role: "user", content: "hello", timestamp: Date.now() }],
      updatedAt: Date.now(),
    }),
  );
  for (const [id, runtimeId] of [
    [linked, "ses_fixture"],
    [orphan, "ses_unknown"],
  ] as const)
    store.save(
      ChatThreadSchema.parse({
        id,
        title: "Source link",
        config: { agent: "opencode" },
        cwd: "/tmp",
        host: null,
        runtimeId,
        sourceId: null,
        backend: "opencode",
        messages: [],
        updatedAt: Date.now(),
      }),
    );
});

afterAll(() => teardownTestApp());

test("links a chat to the discovered session behind its native id", async () => {
  const response = await req(app, "GET", `/chat/threads/${linked}`);
  expect(response.status).toBe(200);
  expect((await response.json()).sourceId).toBe("discovered-opencode");
  expect(new ChatStore(getSqlite()).get(linked)?.sourceId).toBe("discovered-opencode");
});

test("leaves a chat without a discovered session unlinked", async () => {
  const response = await req(app, "GET", `/chat/threads/${orphan}`);
  expect(response.status).toBe(200);
  expect((await response.json()).sourceId).toBeNull();
});

test("links a chat opened through one of its messages", async () => {
  const response = await req(app, "GET", `/chat/threads/by-message/${messageId}`);
  expect(response.status).toBe(200);
  expect((await response.json()).sourceId).toBe("discovered-opencode");
});
