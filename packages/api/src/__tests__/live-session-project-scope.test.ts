import { afterAll, beforeAll, expect, test } from "bun:test";
import { getDb, getSqlite } from "@orc/db/client";
import { bridge_chats, gateway_sessions } from "@orc/db/schema";
import type { createApp } from "../server.js";
import { LIVE_CHAT_ID } from "../sessions/common.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  app = setupTestApp();
  getSqlite().exec(
    "INSERT INTO projects(id,name) VALUES ('scope-session-one','scope-session-one'),('scope-session-two','scope-session-two')",
  );
  await getDb()
    .insert(bridge_chats)
    .values({ id: LIVE_CHAT_ID, platform: "telegram", chat_id: LIVE_CHAT_ID })
    .onConflictDoNothing();
  await getDb()
    .insert(gateway_sessions)
    .values([
      {
        id: "scope-live-one",
        chat_id: LIVE_CHAT_ID,
        backend: "scope-agent",
        mode: "direct",
        project_id: "scope-session-one",
        title: "scopeNeedle first",
        last_activity_at: new Date("2026-01-01"),
      },
      {
        id: "scope-live-two",
        chat_id: LIVE_CHAT_ID,
        backend: "scope-agent",
        mode: "direct",
        project_id: "scope-session-two",
        title: "scopeNeedle second",
        last_activity_at: new Date("2026-02-01"),
      },
      {
        id: "scope-live-none",
        chat_id: LIVE_CHAT_ID,
        backend: "scope-agent",
        mode: "direct",
        project_id: null,
        title: "scopeNeedle shared",
        last_activity_at: new Date("2026-03-01"),
      },
    ]);
});
afterAll(teardownTestApp);

test("live session scope filters before newest-first limit and keeps All and Unassigned distinct", async () => {
  const rows = async (query: string) =>
    (await (await req(app, "GET", `/sessions/live?active=false&agent=scope-agent&${query}`)).json())
      .sessions as { id: string }[];
  expect((await rows("limit=1")).map((row) => row.id)).toEqual(["scope-live-none"]);
  expect((await rows("project_id=scope-session-one&limit=1")).map((row) => row.id)).toEqual([
    "scope-live-one",
  ]);
  expect((await rows("project_id=scope-session-two&limit=1")).map((row) => row.id)).toEqual([
    "scope-live-two",
  ]);
  expect((await rows("project_id=unassigned&limit=1")).map((row) => row.id)).toEqual([
    "scope-live-none",
  ]);
  expect((await rows("project_id=missing")).map((row) => row.id)).toEqual([]);
  expect((await req(app, "GET", "/sessions/live?project_id=")).status).toBe(400);
  expect((await app.request("/api/sessions/live?project_id=scope-session-one")).status).toBe(401);
});

test("session search ranks and limits only the selected project's candidates", async () => {
  const response = await req(
    app,
    "GET",
    "/sessions/live/search?q=scopeNeedle&agent=scope-agent&project_id=scope-session-one&limit=1",
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.hits.map((hit: { id: string }) => hit.id)).toEqual(["scope-live-one"]);
  const unassigned = await (
    await req(
      app,
      "GET",
      "/sessions/live/search?q=scopeNeedle&agent=scope-agent&project_id=unassigned&limit=1",
    )
  ).json();
  expect(unassigned.hits.map((hit: { id: string }) => hit.id)).toEqual(["scope-live-none"]);
  expect(
    (await app.request("/api/sessions/live/search?q=scopeNeedle&project_id=scope-session-one"))
      .status,
  ).toBe(401);
});
