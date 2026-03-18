import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { createLogger } from "@orc/core/logger";
import { ORC_VERSION } from "@orc/core/version";
import { bearerAuth } from "./middleware/auth.js";
import { gatewayRouter } from "./routes/gateway.js";
import { healthRouter } from "./routes/health.js";
import { jobsRouter } from "./routes/jobs.js";
import { mcpToolRouter } from "./routes/mcp-tool.js";
import { memoriesRouter } from "./routes/memories.js";
import { projectsRouter } from "./routes/projects.js";
import { promptsRouter } from "./routes/prompts.js";
import { sessionsRouter } from "./routes/sessions.js";
import { tagsRouter } from "./routes/tags.js";
import { taskLinksRouter } from "./routes/task-links.js";
import { tasksRouter } from "./routes/tasks.js";

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
        orcErr.statusCode as 400 | 401 | 404 | 409 | 500,
      );
    }
    logger.error("Unhandled error", err);
    return c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500);
  });

  app.route("/", healthRouter);
  app.route("/", mcpToolRouter);
  app.route("/", projectsRouter);
  app.route("/", promptsRouter);
  app.route("/", tasksRouter);
  app.route("/", taskLinksRouter);
  app.route("/", memoriesRouter);
  app.route("/", sessionsRouter);
  app.route("/", jobsRouter);
  app.route("/", gatewayRouter);
  app.route("/", tagsRouter);

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

  return app;
}
