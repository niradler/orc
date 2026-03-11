import { loadConfig } from "@orc/core/config";
import { createLogger } from "@orc/core/logger";
import { createApp } from "./server.js";

const logger = createLogger("api");
const config = loadConfig();
const app = createApp();

Bun.serve({
  port: config.api.port,
  hostname: config.api.host,
  fetch: app.fetch,
});

logger.info(`API server running on http://${config.api.host}:${config.api.port}`);
logger.info(`OpenAPI spec: http://${config.api.host}:${config.api.port}/openapi.json`);
logger.info(`Swagger UI:   http://${config.api.host}:${config.api.port}/docs`);

export { app };
