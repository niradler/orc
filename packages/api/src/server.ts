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

export function createApp() {
  const config = loadConfig();
  const app = new OpenAPIHono();

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

  // Routers are registered at root for SDK/CLI/MCP backwards compatibility
  // and under `/api` for the web dashboard (which calls `/api/*`).
  const mountRouters = (prefix: string) => {
    app.route(prefix, chatRouter);
    app.route(prefix, healthRouter);
    app.route(prefix, mcpToolRouter);
    app.route(prefix, projectsRouter);
    app.route(prefix, skillsRouter);
    app.route(prefix, tasksRouter);
    app.route(prefix, taskLinksRouter);
    app.route(prefix, memoriesRouter);
    app.route(prefix, knowledgeRouter);
    app.route(prefix, sessionsRouter);
    app.route(prefix, jobsRouter);
    app.route(prefix, gatewayRouter);
    app.route(prefix, tagsRouter);
  };
  mountRouters("/");
  mountRouters("/api");

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Orc API",
      version: ORC_VERSION,
      description: "Human + AI Orchestration Hub API",
    },
    servers: [{ url: `http://${config.api.host}:${config.api.port}`, description: "Local" }],
  });

  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  // Static web dashboard — mounted last so API routes take precedence.
  app.use("*", createWebStatic());

  return app;
}
