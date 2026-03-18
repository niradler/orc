import { closeDb, createTestDb } from "@orc/db/client";
import { createApp } from "../server.js";

export function setupTestApp() {
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();
  return createApp();
}

export function teardownTestApp() {
  closeDb();
  delete process.env.ORC_API_SECRET;
  delete process.env.ORC_DB_PATH;
}

const AUTH = "Bearer test-secret";

export async function req(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
) {
  return app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
