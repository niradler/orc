import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SessionMessage, SessionMessageResult } from "@orc/core/session-messages";
import { getSqlite } from "@orc/db/client";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
beforeAll(() => {
  app = setupTestApp();
  const sqlite = getSqlite();
  sqlite.run(
    "INSERT OR IGNORE INTO bridge_chats (id, platform, chat_id) VALUES ('session-message-test', 'test', 'session-message-test')",
  );
  const sessions: [string, string, string, string][] = [
    ["session-a", "claude", "native-a", "idle"],
    ["session-b", "codex", "native-b", "idle"],
    ["session-c", "cursor", "native-c", "running"],
  ];
  for (const [id, backend, native, status] of sessions)
    sqlite
      .query(
        "INSERT INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, status, title) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, "session-message-test", backend, "direct", native, status, null);
});
afterAll(teardownTestApp);

test("requires auth for the session message inbox", async () => {
  for (const [method, path] of [
    ["GET", "/sessions/live/session-a/messages"],
    ["POST", "/sessions/live/session-a/messages"],
    ["POST", "/session-messages/missing/cancel"],
    ["POST", "/session-messages/missing/move"],
  ] as const)
    expect((await app.request(`/api${path}`, { method })).status).toBe(401);
});

test("queues, lists, reorders and cancels a human message", async () => {
  const created = await req(app, "POST", "/sessions/live/session-b/messages", {
    body: "Please look at the failing test.",
  });
  expect(created.status).toBe(200);
  const result = await created.json<SessionMessageResult>();
  expect(result.message).toMatchObject({
    target_session_id: "session-b",
    target_backend: "codex",
    sender_kind: "human",
    state: "queued",
  });
  expect(result.target).toMatchObject({ session_id: "session-b", delivery: "hook" });

  const second = await (
    await req(app, "POST", "/sessions/live/session-b/messages", { body: "Second note" })
  ).json<SessionMessageResult>();
  expect(
    (await req(app, "POST", `/session-messages/${second.message.id}/move`, { direction: "up" }))
      .status,
  ).toBe(200);

  const listed = await (await req(app, "GET", "/sessions/live/session-b/messages")).json<{
    messages: SessionMessage[];
  }>();
  expect(listed.messages.map((message) => message.body)).toEqual([
    "Second note",
    "Please look at the failing test.",
  ]);

  expect((await req(app, "POST", `/session-messages/${result.message.id}/cancel`)).status).toBe(
    200,
  );
  expect((await req(app, "POST", `/session-messages/${result.message.id}/cancel`)).status).toBe(
    200,
  );
});

test("attributes a message to the calling session", async () => {
  const created = await (
    await req(
      app,
      "POST",
      "/session-messages",
      { session_id: "native-b", body: "From another agent" },
      { "X-ORC-Session": "session-a" },
    )
  ).json<SessionMessageResult>();
  expect(created.message).toMatchObject({
    sender_kind: "session",
    sender_session_id: "session-a",
    sender_backend: "claude",
    hop: 1,
  });
});

test("rejects a live backend without a hook safe point", async () => {
  expect(
    (await req(app, "POST", "/sessions/live/session-c/messages", { body: "hello" })).status,
  ).toBe(409);
});

test("reports a missing session", async () => {
  expect((await req(app, "GET", "/sessions/live/missing/messages")).status).toBe(404);
});
