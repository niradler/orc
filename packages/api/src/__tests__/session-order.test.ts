import { afterAll, beforeAll, expect, test } from "bun:test";
import { getDb } from "@orc/db/client";
import { sessions } from "@orc/db/schema";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  app = setupTestApp();
  await getDb()
    .insert(sessions)
    .values([
      { id: "date-old", agent: "sort-check", created_at: new Date("2026-01-01") },
      { id: "date-mid", agent: "sort-check", created_at: new Date("2026-02-01") },
      { id: "date-new", agent: "sort-check", created_at: new Date("2026-03-01") },
    ]);
});
afterAll(teardownTestApp);

test("audit sorts before pagination and defaults to newest first", async () => {
  const newest = await req(app, "GET", "/sessions?agent=sort-check&limit=1");
  expect((await newest.json()).sessions[0].id).toBe("date-new");
  const oldest = await req(app, "GET", "/sessions?agent=sort-check&limit=1&order=asc");
  expect((await oldest.json()).sessions[0].id).toBe("date-old");
  const next = await req(app, "GET", "/sessions?agent=sort-check&limit=1&offset=1&order=asc");
  expect((await next.json()).sessions[0].id).toBe("date-mid");
  expect((await req(app, "GET", "/sessions?order=unexpected")).status).toBe(400);
});
