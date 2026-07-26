import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { probeBackends } from "@orc/agent-runtime";
import { loadConfig } from "@orc/core/config";

const app = new OpenAPIHono();

const BackendSchema = z
  .object({
    name: z.string(),
    kind: z.enum(["in-process", "cli", "http"]).openapi({
      description:
        "How the backend reaches its agent: in-process needs no external tool, cli spawns a binary, http calls a service.",
    }),
    available: z.boolean().openapi({ description: "Preflight passed — usable right now" }),
    error: z.string().nullable().openapi({ description: "Why it is unavailable" }),
    requires: z.string().openapi({ description: "What it needs, satisfied or not" }),
    target: z.string().nullable().openapi({ description: "Resolved binary or endpoint" }),
    source: z.string().nullable().openapi({ description: "path | bundled | config | env" }),
    version: z.string().nullable(),
  })
  .openapi("AgentBackend");

const listRoute = createRoute({
  method: "get",
  path: "/backends",
  tags: ["System"],
  summary: "List agent backends and whether each one can actually run",
  description:
    "Probes every registered backend. Without this, 'can I run this agent?' is only " +
    "answerable by starting a task and reading the error.",
  responses: {
    200: {
      description: "Backend list",
      content: {
        "application/json": {
          schema: z.object({
            backends: z.array(BackendSchema),
            default_backend: z.string().openapi({
              description: "Backend a task with no agent_backend runs (agent_loop.default_backend)",
            }),
          }),
        },
      },
    },
  },
});

app.openapi(listRoute, async (c) => {
  const backends = await probeBackends();
  return c.json({
    backends,
    default_backend: loadConfig().agent_loop.default_backend,
  });
});

export { app as backendsRouter };
