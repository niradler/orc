import { release } from "node:os";
import { dirname } from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import { globalConfigPath } from "@orc/core/config";
import { ORC_VERSION } from "@orc/core/version";
import { createRouter } from "../lib/router.js";
import { instanceId, requestRestart, requestShutdown } from "../lifecycle.js";

const app = createRouter();
const startedAt = new Date().toISOString();

app.openapi(
  createRoute({
    method: "get",
    path: "/system/about",
    tags: ["System"],
    summary: "Describe the running ORC server, its runtime and data folder",
    responses: {
      200: {
        description: "Server build and environment",
        content: {
          "application/json": {
            schema: z
              .object({
                version: z.string(),
                platform: z.string(),
                arch: z.string(),
                os_release: z.string(),
                runtime: z.string(),
                data_dir: z.string(),
                started_at: z.string(),
                instance_id: z.string(),
              })
              .openapi("SystemAbout"),
          },
        },
      },
    },
  }),
  (c) =>
    c.json({
      version: ORC_VERSION,
      platform: process.platform,
      arch: process.arch,
      os_release: release(),
      runtime: typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`,
      data_dir: dirname(globalConfigPath()),
      started_at: startedAt,
      instance_id: instanceId,
    }),
);

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

app.openapi(
  createRoute({
    method: "post",
    path: "/system/shutdown",
    tags: ["System"],
    summary:
      "Stop the daemon gracefully: refuse new chat turns, let active ones finish and persist their resumable session state, then exit",
    request: {
      body: { required: true, content: { "application/json": { schema: z.object({}).strict() } } },
    },
    responses: {
      202: {
        description: "Shutdown accepted; the process exits once active work is durable",
        content: {
          "application/json": {
            schema: z
              .object({ instance_id: z.string(), shutting_down: z.literal(true) })
              .openapi("ShutdownResponse"),
          },
        },
      },
      503: {
        description:
          "This process registered no shutdown handler, as with an embedded app that mounts the API routes without the daemon runtime",
        content: {
          "application/json": { schema: z.object({ error: z.string(), code: z.string() }) },
        },
      },
    },
  }),
  (c) => {
    requestShutdown();
    return c.json({ instance_id: instanceId, shutting_down: true as const }, 202);
  },
);

export { app as systemRouter };
