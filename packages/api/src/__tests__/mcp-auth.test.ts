import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { closeDb, createTestDb } from "@orc/db/client";
import { Hono } from "hono";
import { mcpRouter } from "../routes/mcp.js";
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

describe("MCP HTTP endpoint auth", () => {
  test("POST /mcp without a bearer token is rejected when a secret is set", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /mcp with a wrong bearer token is rejected", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /mcp with the correct bearer token passes auth", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).not.toBe(401);
  });

  test("the mcpRouter sub-app enforces auth on its own (not just via parent)", async () => {
    // Mount the router in isolation to prove its own bearerAuth guards /mcp,
    // independent of the parent app's wildcard middleware.
    const isolated = new Hono();
    isolated.onError((err, c) => {
      const status = err instanceof OrcError ? err.statusCode : 500;
      return c.json({ error: err.message }, status as 401 | 500);
    });
    isolated.route("/", mcpRouter);
    const res = await isolated.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
