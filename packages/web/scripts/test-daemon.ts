/**
 * test-daemon.ts
 *
 * Minimal ORC daemon for the real-agent E2E demo.
 * Starts the API server AND the task loop in the same process.
 *
 * Intended to be spawned by run-real-agent-demo.ts — not used directly.
 *
 * Required env vars (set by the runner):
 *   ORC_API_PORT   — port to listen on
 *   ORC_DB_PATH    — path to the SQLite DB (use a temp path for isolation)
 *   ORC_AGENT_LOOP_ENABLED=true
 */

import { createApp } from "@orc/api/server";
import { loadConfig } from "@orc/core/config";
import { createLogger } from "@orc/core/logger";
import { ensureSystemJob } from "@orc/runner/task-loop";
import { startScheduler, startTaskLoop } from "@orc/runner";

const logger = createLogger("test-daemon");
const config = loadConfig();
const app = createApp();

const server = Bun.serve({
  port: config.api.port,
  hostname: config.api.host,
  fetch: app.fetch,
  idleTimeout: 0,
});

await ensureSystemJob();
startTaskLoop();

logger.info(
  `[test-daemon] API + task loop ready on http://${config.api.host}:${config.api.port}`,
);

function shutdown() {
  server.stop(true).catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGBREAK" as NodeJS.Signals, shutdown);
