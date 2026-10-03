import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb } from "@orc/db/client";
import { createApp } from "../server.js";

// loadConfig() caches per process, and `bun test` at the root runs every package's files in one
// process; without a reset the app keeps a secret cached by an earlier file and answers 401.
export function setupTestApp() {
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
  return createApp();
}

export function teardownTestApp() {
  closeDb();
  delete process.env.ORC_API_SECRET;
  delete process.env.ORC_DB_PATH;
  resetConfig();
}

const AUTH = "Bearer test-secret";

// biome-ignore lint/suspicious/noExplicitAny: tests use dynamic response shapes
type AnyJsonResponse = Omit<Response, "json"> & { json<T = any>(): Promise<T> };

export async function req(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<AnyJsonResponse> {
  const fullPath = path.startsWith("/api") ? path : `/api${path}`;
  const res = await app.request(fullPath, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res as AnyJsonResponse;
}
