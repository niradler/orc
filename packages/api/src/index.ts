import { loadConfig } from "@orc/core/config";
import { createLogger } from "@orc/core/logger";
import { createApp } from "./server.js";

const logger = createLogger("api");
const config = loadConfig();
const app = createApp();

const server = Bun.serve({
  port: config.api.port,
  hostname: config.api.host,
  fetch: app.fetch,
  // SSE streams (/chat/stream) can idle between agent chunks longer than Bun's
  // 10s default, so we raise the idle timeout to Bun's max (255s) rather than
  // disabling it. Disabling it (0) let half-open/abandoned sockets accumulate
  // forever — a slow leak that wedged the daemon after ~a day. The stream
  // handlers send periodic keepalives so legitimate long-running streams stay
  // active, and enforce their own max-duration backstop.
  idleTimeout: 255,
});

logger.info(`API server running on http://${config.api.host}:${config.api.port}`);
logger.info(`OpenAPI spec: http://${config.api.host}:${config.api.port}/openapi.json`);
logger.info(`Swagger UI:   http://${config.api.host}:${config.api.port}/docs`);

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down…`);
  try {
    // true = drop in-flight connections immediately so the port is released fast
    await server.stop(true);
    logger.info("Server stopped, port released");
  } catch (err) {
    logger.error("Error during shutdown", err);
  } finally {
    process.exit(exitCode);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// Windows: Ctrl+Break
process.on("SIGBREAK" as NodeJS.Signals, () => shutdown("SIGBREAK"));

// Unhandled rejections are usually recoverable (a stray fire-and-forget promise)
// — log and keep serving rather than crash on an opaque trace.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason);
});
// An uncaught exception leaves the process in an undefined state; log and exit
// non-zero so the supervisor (systemd/launchd/daemon) restarts it cleanly
// instead of limping along corrupted.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception — exiting for clean restart", err);
  void shutdown("uncaughtException", 1);
});

export { app };
