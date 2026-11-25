import { loadConfig } from "@orc/core/config";
import { createLogger } from "@orc/core/logger";
import { RESTART_EXIT_CODE } from "@orc/core/process-supervisor";
import { initializeAgentPreferences } from "@orc/core/provider-service";
import { closeDb, getSqlite } from "@orc/db/client";
import { importConfigMcpPrompts } from "@orc/db/mcp-prompts";
import { ProjectSecretStore } from "@orc/db/project-secrets";
import { startChannelRuntime } from "@orc/gateway/channel-runtime";
import {
  closeKnowledgeService,
  getKnowledgeService,
  startKnowledgeMaintenance,
} from "@orc/knowledge";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { reconcileChatTurnLeases } from "./chat-recovery.js";
import { startGithubIssueSync } from "./git/issue-sync.js";
import { startHumanRequestDelivery } from "./human-request-delivery.js";
import { withKbJobHooks } from "./kb-jobs.js";
import {
  beginDrain,
  registerRestartHandler,
  registerShutdownHandler,
  runShutdownHooks,
} from "./lifecycle.js";
import { startNotificationMaintenance } from "./notifications.js";
import { startAttentionPush, startJobPush } from "./push/service.js";
import { drainChatTurns } from "./routes/chat.js";
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
import { handleVoiceUpgrade, type VoiceSocketData, voiceWebsocket } from "./voice.js";

const logger = createLogger("api");
const config = loadConfig();
try {
  importConfigMcpPrompts(getSqlite());
} catch (err) {
  logger.error("Could not move MCP prompts from config.json into the database", err);
}
try {
  new ProjectSecretStore(getSqlite()).loadAllForRedaction();
} catch (err) {
  logger.error("Could not register saved project secrets with redactor", err);
}
// Browser e2e only: a deterministic goal worker so the loop test needs no paid agent.
if (process.env.ORC_E2E_GOAL_FIXTURE === "1") await import("./e2e-goal-fixture.js");
const app = createApp();

// Settle chat turn leases the previous daemon left running BEFORE the port
// opens. A turn the previous daemon could not finish is recorded as
// interrupted, and its native session stays resumable. Doing this after
// `Bun.serve` would let an early client read a `running` lease it can never
// observe finishing, and send into it. Idempotent, so repeated boots are safe.
// A failure here must not keep the daemon down: the send path settles a stale
// lease on its own, so the API still comes up.
try {
  const leaseReconcile = await reconcileChatTurnLeases();
  if (leaseReconcile.interrupted > 0)
    logger.info(
      `Reconciled ${leaseReconcile.interrupted} chat turn(s) interrupted by the previous daemon`,
    );
} catch (error) {
  logger.error("Chat turn lease reconcile failed; the send path will settle them", error);
}

type SocketData = TerminalSocketData | VoiceSocketData;
const socketHandler = (ws: ServerWebSocket<SocketData>) =>
  ("threadId" in ws.data ? voiceWebsocket : terminalWebsocket) as WebSocketHandler<SocketData>;

const server = Bun.serve<SocketData>({
  port: config.api.port,
  hostname: config.api.host,
  fetch(req, srv) {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const terminal = handleTerminalUpgrade(req, srv as Server<TerminalSocketData>);
      if (terminal !== null) return terminal;
      const voice = handleVoiceUpgrade(req, srv as Server<VoiceSocketData>);
      if (voice !== null) return voice;
    }
    return app.fetch(req);
  },
  websocket: {
    maxPayloadLength: 1024 * 1024,
    open: (ws) => socketHandler(ws).open?.(ws),
    message: (ws, message) => socketHandler(ws).message?.(ws, message),
    close: (ws, code, reason) => socketHandler(ws).close?.(ws, code, reason),
  },
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
  // Draining first: new turns are refused while active ones finish and persist
  // their resumable identity, so a stop can never orphan a conversation.
  beginDrain();
  // A stop that overruns its drain budget is still an intentional stop: exiting
  // non-zero here would make a supervisor (or systemd's Restart=on-failure)
  // resurrect a daemon the operator asked to stop. The resumable state is
  // already durable, so the requested code is always the honest one.
  const forceExit = setTimeout(() => process.exit(exitCode), 10000);
  forceExit.unref();
  await drainChatTurns().catch((error) => logger.error("Chat turn drain failed", error));
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
registerShutdownHandler(() => shutdown("api-shutdown"));

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
