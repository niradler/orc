import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { createLogger } from "@orc/core/logger";
import { ORC_VERSION } from "@orc/core/version";
import { bearerAuth } from "./middleware/auth.js";
import { chatRouter } from "./routes/chat.js";
import { gatewayRouter } from "./routes/gateway.js";
import { healthRouter } from "./routes/health.js";
import { jobsRouter } from "./routes/jobs.js";
import { knowledgeRouter } from "./routes/knowledge.js";
import { mcpRouter } from "./routes/mcp.js";
import { mcpToolRouter } from "./routes/mcp-tool.js";
import { memoriesRouter } from "./routes/memories.js";
import { projectsRouter } from "./routes/projects.js";
import { sessionsRouter } from "./routes/sessions.js";
import { skillsRouter } from "./routes/skills.js";
import { tagsRouter } from "./routes/tags.js";
import { taskLinksRouter } from "./routes/task-links.js";
import { tasksRouter } from "./routes/tasks.js";
import { createWebStatic } from "./static.js";

const logger = createLogger("api");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function createApp() {
  const config = loadConfig();
  const app = new OpenAPIHono();

  if (!config.api.secret && !LOOPBACK_HOSTS.has(config.api.host)) {
    logger.warn(
      `SECURITY: API is bound to ${config.api.host} with NO authentication. ` +
        "Every endpoint — including job execution (arbitrary shell commands) and MCP tools — is open to the network. " +
        "Set ORC_API_SECRET (or api.secret in config.json) before exposing ORC beyond localhost.",
    );
  }

  app.use("*", bearerAuth(config.api.secret));

  app.onError((err, c) => {
    const orcErr = err instanceof OrcError ? err : null;
    if (orcErr) {
      return c.json(
        { error: orcErr.message, code: orcErr.code },
        orcErr.statusCode as 400 | 401 | 404 | 409 | 500 | 503,
      );
    }
    logger.error("Unhandled error", err);
    return c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500);
  });

  app.route("/api", chatRouter);
  app.route("/api", healthRouter);
  app.route("/api", mcpToolRouter);
  app.route("/", mcpRouter);
  app.route("/api", projectsRouter);
  app.route("/api", skillsRouter);
  app.route("/api", tasksRouter);
  app.route("/api", taskLinksRouter);
  app.route("/api", memoriesRouter);
  app.route("/api", knowledgeRouter);
  app.route("/api", sessionsRouter);
  app.route("/api", jobsRouter);
  app.route("/api", gatewayRouter);
  app.route("/api", tagsRouter);

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Orc API",
      version: ORC_VERSION,
      description: "AI Orchestration Hub API",
    },
    servers: [{ url: `http://${config.api.host}:${config.api.port}`, description: "Local" }],
  });

  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  // Static web dashboard - mounted last so API routes take precedence.
  app.use("*", createWebStatic());

  return app;
}
