import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { ORC_VERSION } from "@orc/core/version";

const app = new OpenAPIHono();

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("ok"),
            version: z.string(),
            uptime: z.number(),
            agent_loop: z.object({
              enabled: z.boolean(),
              poll_interval_minutes: z.number(),
              max_workers: z.number(),
            }),
          }),
        },
      },
    },
  },
});

const startTime = Date.now();

app.openapi(healthRoute, (c) => {
  const { agent_loop } = loadConfig();
  return c.json({
    status: "ok" as const,
    version: ORC_VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    agent_loop: {
      enabled: agent_loop.enabled,
      poll_interval_minutes: agent_loop.poll_interval_minutes,
      max_workers: agent_loop.max_workers,
    },
  });
});

export { app as healthRouter };
