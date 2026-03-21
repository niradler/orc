import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
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
          }),
        },
      },
    },
  },
});

const startTime = Date.now();

app.openapi(healthRoute, (c) => {
  return c.json({
    status: "ok" as const,
    version: ORC_VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

export { app as healthRouter };
