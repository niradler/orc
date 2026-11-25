import { createRoute, z } from "@hono/zod-openapi";
import { probeBackends } from "@orc/agent-runtime";
import { loadConfig } from "@orc/core/config";
import { AgentCapabilitiesSchema } from "@orc/core/types";
import { createRouter } from "../lib/router.js";

const app = createRouter();

const BackendSchema = z
  .object({
    name: z.string(),
    capabilities: AgentCapabilitiesSchema,
    kind: z.enum(["in-process", "cli", "http"]).openapi({
      description:
        "How the backend reaches its agent: in-process needs no external tool, cli spawns a binary, http calls a service.",
    }),
    tool_allowlist: z.boolean().openapi({
      description:
        "Whether a session here can be restricted to an explicit tool whitelist. A knowledge base digest always runs with one, so it can only use such a backend.",
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
    // The probe's field names are camelCase; this contract is snake_case.
    backends: backends.map(({ toolAllowlist, ...probe }) => ({
      ...probe,
      tool_allowlist: toolAllowlist,
    })),
    default_backend: loadConfig().agent_loop.default_backend,
  });
});

export { app as backendsRouter };
