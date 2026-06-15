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
async function shutdown(signal: string) {
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
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// Windows: Ctrl+Break
process.on("SIGBREAK" as NodeJS.Signals, () => shutdown("SIGBREAK"));

// Keep fire-and-forget rejections from crashing the server with an opaque trace.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason);
});
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
});

export { app };
