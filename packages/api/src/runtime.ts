import { loadConfig } from "@orc/core/config";
import { createLogger } from "@orc/core/logger";
import { RESTART_EXIT_CODE } from "@orc/core/process-supervisor";
import { initializeAgentPreferences } from "@orc/core/provider-service";
import { closeDb, getSqlite } from "@orc/db/client";
import { importConfigMcpPrompts } from "@orc/db/mcp-prompts";
import { startChannelRuntime } from "@orc/gateway/channel-runtime";
import {
  closeKnowledgeService,
  getKnowledgeService,
  startKnowledgeMaintenance,
} from "@orc/knowledge";
import { startGithubIssueSync } from "./git/issue-sync.js";
import { startHumanRequestDelivery } from "./human-request-delivery.js";
import { withKbJobHooks } from "./kb-jobs.js";
import { registerRestartHandler, runShutdownHooks } from "./lifecycle.js";
import { startNotificationMaintenance } from "./notifications.js";
import { startAttentionPush, startJobPush } from "./push/service.js";
import { createApp } from "./server.js";
import { startSessionMessageDelivery } from "./session-message-delivery.js";
import { reconcileSessionProjects, startSessionWatcher } from "./session-watcher.js";
import { closeSessionArchive } from "./sessions/archive.js";
import { shutdownTerminals } from "./terminals/service.js";
import {
  handleTerminalUpgrade,
  type TerminalSocketData,
  terminalWebsocket,
} from "./terminals/ws.js";

const logger = createLogger("api");
const config = loadConfig();
try {
  importConfigMcpPrompts(getSqlite());
} catch (err) {
  logger.error("Could not move MCP prompts from config.json into the database", err);
}
const app = createApp();

const server = Bun.serve<TerminalSocketData>({
  port: config.api.port,
  hostname: config.api.host,
  fetch(req, srv) {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const handled = handleTerminalUpgrade(req, srv);
      if (handled !== null) return handled;
    }
    return app.fetch(req);
  },
  websocket: terminalWebsocket,
  // SSE streams (/chat/stream) can idle between agent chunks longer than Bun's
  // 10s default, so we raise the idle timeout to Bun's max (255s) rather than
  // disabling it. Disabling it (0) let half-open/abandoned sockets accumulate
  // forever — a slow leak that wedged the daemon after ~a day. The stream
  // handlers send periodic keepalives so legitimate long-running streams stay
  // active, and enforce their own max-duration backstop.
  idleTimeout: 255,
});

if (server.port === undefined) throw new Error("ORC API did not bind a TCP port");
// Keep callbacks and spawned clients on the bound port when the OS selected it.
config.api.port = server.port;
process.env.ORC_API_PORT = String(server.port);
// Persist discovery after publishing the bound port to callers holding this config.
initializeAgentPreferences();

const stopSessionWatcher = startSessionWatcher();
void reconcileSessionProjects().catch((error) =>
  logger.error("Initial session project mapping failed", error),
);
const stopAttentionPush = startAttentionPush();
const stopJobPush = startJobPush();
const stopHumanRequestDelivery = startHumanRequestDelivery();
const stopSessionMessageDelivery = startSessionMessageDelivery();
const stopGithubIssueSync = startGithubIssueSync();
const stopNotificationMaintenance = startNotificationMaintenance();
const channels = startChannelRuntime().catch(() => {
  logger.error("Channels failed to start; inspect Channels in Settings");
  return async () => {};
});
// Recover interrupted knowledge jobs and start folder rescans; failures must not stop the API.
startKnowledgeMaintenance()
  .then(async () => withKbJobHooks(await getKnowledgeService()).ensureLearningsKbs())
  .catch((err) => logger.error("Knowledge service failed to start", err));

logger.info(`API server running on http://${config.api.host}:${config.api.port}`);
logger.info(`OpenAPI spec: http://${config.api.host}:${config.api.port}/openapi.json`);
logger.info(`Swagger UI:   http://${config.api.host}:${config.api.port}/docs`);

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down…`);
  const forceExit = setTimeout(
    () => process.exit(exitCode === RESTART_EXIT_CODE ? RESTART_EXIT_CODE : 1),
    10000,
  );
  forceExit.unref();
  stopSessionWatcher();
  stopAttentionPush();
  stopJobPush();
  stopHumanRequestDelivery();
  stopSessionMessageDelivery();
  stopNotificationMaintenance();
  await stopGithubIssueSync();
  await (await channels)();
  shutdownTerminals();
  await runShutdownHooks();
  try {
    const results = await Promise.allSettled([closeKnowledgeService(), closeSessionArchive()]);
    for (const result of results)
      if (result.status === "rejected")
        logger.error("Error stopping indexed storage", result.reason);
  } catch (err) {
    logger.error("Error stopping knowledge service", err);
  }
  try {
    // true = drop in-flight connections immediately so the port is released fast
    await server.stop(true);
    logger.info("Server stopped, port released");
  } catch (err) {
    logger.error("Error during shutdown", err);
  } finally {
    closeDb();
    process.exit(exitCode);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// Windows: Ctrl+Break
process.on("SIGBREAK" as NodeJS.Signals, () => shutdown("SIGBREAK"));
process.on("message", (message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "orc-shutdown"
  )
    void shutdown("supervisor");
});
registerRestartHandler(() => shutdown("restart", RESTART_EXIT_CODE));

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
