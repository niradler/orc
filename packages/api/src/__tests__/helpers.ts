import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb } from "@orc/db/client";
import { createApp } from "../server.js";

const originalActiveProject = process.env.ORC_ACTIVE_PROJECT;
const originalOrcHome = process.env.ORC_HOME;
let testHome: string | null = null;

// A test run must never read or write the real ~/.orc: ORC_HOME is inherited
// from the parent shell, and provider or chat settings written there survive
// the test as fixture data. Point it at a per-file temporary home instead.
function isolateHome() {
  if (!testHome) testHome = mkdtempSync(join(tmpdir(), "orc-api-test-"));
  process.env.ORC_HOME = testHome;
}

// loadConfig() caches per process, and `bun test` at the root runs every package's files in one
// process; without a reset the app keeps a secret cached by an earlier file and answers 401.
export function setupTestApp() {
  isolateHome();
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_ACTIVE_PROJECT = "";
  resetConfig();
  createTestDb();
  return createApp();
}

export function teardownTestApp() {
  closeDb();
  delete process.env.ORC_API_SECRET;
  delete process.env.ORC_DB_PATH;
  if (originalActiveProject === undefined) delete process.env.ORC_ACTIVE_PROJECT;
  else process.env.ORC_ACTIVE_PROJECT = originalActiveProject;
  if (originalOrcHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = originalOrcHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = null;
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
  headers?: Record<string, string>,
): Promise<AnyJsonResponse> {
  const fullPath = path.startsWith("/api") ? path : `/api${path}`;
  const res = await app.request(fullPath, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH,
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res as AnyJsonResponse;
}

/**
 * Remove a test temp tree, waiting out Windows' asynchronous handle release.
 * Bun 1.4.4 ignores rmSync's maxRetries, and a just-closed sqlite/fs.watch/child
 * handle can lock the tree for several seconds under full-gate load, so retry
 * explicitly. Callers give their hook a budget above the ~10s loop.
 */
export async function removeTempTree(path: string): Promise<void> {
  Bun.gc(true);
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt >= 100) throw error;
      await Bun.sleep(100);
    }
  }
}
