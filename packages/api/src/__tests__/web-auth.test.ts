import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb } from "@orc/db/client";
import { createApp } from "../server.js";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
  app = createApp();
});

afterAll(() => {
  closeDb();
  resetConfig();
  delete process.env.ORC_API_SECRET;
  delete process.env.ORC_DB_PATH;
});

describe("web dashboard with an API secret set", () => {
  test("the dashboard page and assets are served without a bearer token", async () => {
    for (const path of ["/", "/index.html", "/assets/missing.js", "/tasks"]) {
      const res = await app.request(path, { headers: { Accept: "text/html" } });
      expect(res.status, path).not.toBe(401);
    }
  });

  test("API, OpenAPI and docs still require the bearer token", async () => {
    for (const path of ["/api/tasks", "/api/terminals", "/openapi.json", "/docs"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
    }
  });

  test("API accepts the correct bearer token", async () => {
    const res = await app.request("/api/projects", {
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(res.status).toBe(200);
  });

  test("an explicitly empty secret permits requests without a token", async () => {
    try {
      process.env.ORC_API_SECRET = "";
      resetConfig();
      const openApp = createApp();
      for (const path of ["/api/tasks", "/api/projects", "/api/terminals", "/openapi.json"]) {
        expect((await openApp.request(path)).status, path).toBe(200);
      }
      expect((await app.request("/api/tasks")).status).toBe(401);
    } finally {
      process.env.ORC_API_SECRET = "test-secret";
      resetConfig();
    }
  });
});
