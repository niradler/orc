import { afterEach, beforeEach, expect, test } from "bun:test";
import { getSqlite } from "@orc/db/client";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  app = setupTestApp();
});
afterEach(teardownTestApp);

test("authenticated chat listing exposes only summary identity for flat history deduplication", async () => {
  const current = crypto.randomUUID();
  const legacy = crypto.randomUUID();
  const corrupt = crypto.randomUUID();
  const insert = getSqlite().query(
    "INSERT INTO chat_threads (id, title, updated_at, data) VALUES (?, ?, ?, ?)",
  );
  insert.run(
    current,
    "Current chat",
    300,
    JSON.stringify({
      config: {
        agent: "claude",
        system: "Private instructions",
        agentOptions: { token: "Private token" },
      },
      runtimeId: "native-id",
      sourceId: "source-id",
      cwd: "/private",
      host: "remote-a",
      messages: [{ content: "Private message" }],
    }),
  );
  insert.run(legacy, "Legacy chat", 200, "{}");
  insert.run(corrupt, "Corrupt chat", 100, "broken-json");
  const response = await req(app, "GET", "/chat/threads");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({
    threads: [
      {
        id: current,
        title: "Current chat",
        updatedAt: 300,
        running: false,
        agent: "claude",
        runtimeId: "native-id",
        sourceId: "source-id",
        host: "remote-a",
      },
      {
        id: legacy,
        title: "Legacy chat",
        updatedAt: 200,
        running: false,
        agent: null,
        runtimeId: null,
        sourceId: null,
        host: null,
      },
      {
        id: corrupt,
        title: "Corrupt chat",
        updatedAt: 100,
        running: false,
        agent: null,
        runtimeId: null,
        sourceId: null,
        host: null,
      },
    ],
  });
  expect(JSON.stringify(body)).not.toContain("Private");
  expect(JSON.stringify(body)).not.toContain("/private");
});

test("chat summary metadata does not bypass API authentication", async () => {
  const response = await app.request("/api/chat/threads");
  expect(response.status).toBe(401);
});
