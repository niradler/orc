import { swaggerUI } from "@hono/swagger-ui";
import { type ChangeResource, changes } from "@orc/core/changes";
import { configuredApiSecret, loadConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { createLogger } from "@orc/core/logger";
import { ORC_VERSION } from "@orc/core/version";
import { HTTPException } from "hono/http-exception";
import { ZodError, z } from "zod";
import { createRouter } from "./lib/router.js";
import { constraintFailure } from "./lib/sqlite-errors.js";
import { bearerAuth } from "./middleware/auth.js";
import { auditRouter } from "./routes/audit.js";
import { backendsRouter } from "./routes/backends.js";
import { channelsRouter } from "./routes/channels.js";
import { chatRouter } from "./routes/chat.js";
import { eventsRouter } from "./routes/events.js";
import { flowsRouter } from "./routes/flows.js";
import { gatewayRouter } from "./routes/gateway.js";
import { gitRouter } from "./routes/git.js";
import { githubRouter } from "./routes/github.js";
import { healthRouter } from "./routes/health.js";
import { humanRequestsRouter } from "./routes/human-requests.js";
import { integrationsRouter } from "./routes/integrations.js";
import { jobsRouter } from "./routes/jobs.js";
import { knowledgeRouter } from "./routes/knowledge.js";
import { mcpRouter } from "./routes/mcp.js";
import { mcpToolRouter } from "./routes/mcp-tool.js";
import { memoriesRouter } from "./routes/memories.js";
import { primitivesRouter } from "./routes/primitives.js";
import { projectsRouter } from "./routes/projects.js";
import { pushRouter } from "./routes/push.js";
import { rulesRouter } from "./routes/rules.js";
import { scratchpadsRouter } from "./routes/scratchpads.js";
import { searchRouter } from "./routes/search.js";
import { sessionArchiveRouter } from "./routes/session-archive.js";
import { sessionHandoffsRouter } from "./routes/session-handoffs.js";
import { sessionsRouter } from "./routes/sessions.js";
import { settingsRouter } from "./routes/settings.js";
import { skillsRouter } from "./routes/skills.js";
import { sshRouter } from "./routes/ssh.js";
import { systemRouter } from "./routes/system.js";
import { tagsRouter } from "./routes/tags.js";
import { taskLinksRouter } from "./routes/task-links.js";
import { tasksRouter } from "./routes/tasks.js";
import { terminalGitRouter } from "./routes/terminal-git.js";
import { terminalsRouter } from "./routes/terminals.js";
import { webhookPublicRouter, webhooksRouter } from "./routes/webhooks.js";
import { createWebStatic } from "./static.js";

const logger = createLogger("api");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function createApp() {
  const config = loadConfig();
  const app = createRouter();

  if (!configuredApiSecret(config.api.secret) && !LOOPBACK_HOSTS.has(config.api.host)) {
    logger.warn(
      `SECURITY: API is bound to ${config.api.host} with NO authentication. ` +
        "Every endpoint — including job execution (arbitrary shell commands) and MCP tools — is open to the network. " +
        "Set ORC_API_SECRET (or api.secret in config.json) before exposing ORC beyond localhost.",
    );
  }

  const auth = bearerAuth(configuredApiSecret(config.api.secret));
  for (const path of ["/api/*", "/openapi.json", "/docs"]) app.use(path, auth);

  const fileResources: Record<string, ChangeResource[]> = {
    skills: ["skills"],
    agents: ["agents"],
    flows: ["flows"],
    packages: ["packages", "skills", "agents"],
    settings: ["settings"],
    ssh: ["ssh", "backends", "terminals", "sessions", "git"],
    git: ["git", "files"],
  };
  app.use("/api/*", async (c, next) => {
    await next();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) || c.res.status >= 400) return;
    const resource = c.req.path.split("/")[2] ?? "";
    const topics = fileResources[resource];
    if (topics) changes.publish(...topics);
    if (resource === "terminals" && /\/(git|files|worktrees)(\/|$)/.test(c.req.path))
      changes.publish("git", "files");
  });

  app.onError((err, c) => {
    const orcErr = err instanceof OrcError ? err : null;
    // Service-level schema checks (beyond route validation) are client errors, not crashes.
    if (err instanceof ZodError)
      return c.json({ error: z.prettifyError(err), code: "VALIDATION_ERROR" }, 400);
    if (orcErr) {
      return c.json(
        { error: orcErr.message, code: orcErr.code },
        orcErr.statusCode as 400 | 401 | 403 | 404 | 409 | 500 | 503,
      );
    }
    // Hono's own request errors (e.g. malformed JSON body) carry their status.
    if (err instanceof HTTPException)
      return c.json(
        { error: err.message, code: err.status === 400 ? "VALIDATION_ERROR" : "HTTP_ERROR" },
        err.status,
      );
    const constraint = constraintFailure(err);
    if (constraint) {
      logger.warn(`Constraint violation on ${c.req.method} ${c.req.path}: ${constraint.detail}`);
      return c.json({ error: constraint.error, code: constraint.code }, constraint.status);
    }
    logger.error("Unhandled error", err);
    return c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500);
  });

  app.route("/", webhookPublicRouter);
  app.route("/api", backendsRouter);
  app.route("/api", eventsRouter);
  app.route("/api", sshRouter);
  app.route("/api", chatRouter);
  app.route("/api", pushRouter);
  app.route("/api", healthRouter);
  app.route("/api", humanRequestsRouter);
  app.route("/api", settingsRouter);
  app.route("/api", channelsRouter);
  app.route("/api", systemRouter);
  app.route("/api", mcpToolRouter);
  app.route("/api", integrationsRouter);
  app.route("/", mcpRouter);
  app.route("/api", projectsRouter);
  app.route("/api", skillsRouter);
  app.route("/api", rulesRouter);
  app.route("/api", searchRouter);
  app.route("/api", primitivesRouter);
  app.route("/api", flowsRouter);
  app.route("/api", tasksRouter);
  app.route("/api", taskLinksRouter);
  app.route("/api", memoriesRouter);
  app.route("/api", scratchpadsRouter);
  app.route("/api", auditRouter);
  app.route("/api", knowledgeRouter);
  app.route("/api", sessionArchiveRouter);
  app.route("/api", sessionsRouter);
  app.route("/api", sessionHandoffsRouter);
  app.route("/api", jobsRouter);
  app.route("/api", gatewayRouter);
  app.route("/api", tagsRouter);
  app.route("/api", terminalsRouter);
  app.route("/api", gitRouter);
  app.route("/api", terminalGitRouter);
  app.route("/api", githubRouter);
  app.route("/api", webhooksRouter);

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Orc API",
      version: ORC_VERSION,
      description: "AI Orchestration Hub API",
    },
    servers: [
      {
        url: `http://${config.api.host}:${config.api.port}`,
        description: "Local",
      },
    ],
  });

  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  // Static web dashboard - mounted last so API routes take precedence.
  app.use("*", createWebStatic());

  return app;
}
