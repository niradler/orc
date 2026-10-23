import { createRoute, z } from "@hono/zod-openapi";
import { createRouter } from "../lib/router.js";
import { instanceId, requestRestart } from "../lifecycle.js";

const app = createRouter();
app.openapi(
  createRoute({
    method: "post",
    path: "/system/restart",
    tags: ["System"],
    summary: "Restart ORC and reload server and execution-host state",
    request: {
      body: { required: true, content: { "application/json": { schema: z.object({}).strict() } } },
    },
    responses: {
      202: {
        description: "Restart accepted; reconnect when health reports a new instance_id",
        content: {
          "application/json": {
            schema: z
              .object({ instance_id: z.string(), restarting: z.literal(true) })
              .openapi("RestartResponse"),
          },
        },
      },
    },
  }),
  (c) => {
    requestRestart();
    return c.json({ instance_id: instanceId, restarting: true as const }, 202);
  },
);

export { app as systemRouter };
