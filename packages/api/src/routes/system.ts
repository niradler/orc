import { release } from "node:os";
import { dirname } from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import { globalConfigPath } from "@orc/core/config";
import { readRecentLogs } from "@orc/core/logger";
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

const LogEntrySchema = z.object({
  ts: z.string().nullable(),
  level: z.enum(["debug", "info", "warn", "error"]).nullable(),
  ns: z.string().nullable(),
  msg: z.string(),
  data: z.string().optional(),
  source: z.enum(["orc", "daemon"]),
});

app.openapi(
  createRoute({
    method: "get",
    path: "/system/logs",
    tags: ["System"],
    summary: "Read recent structured daemon logs and spawn diagnostics",
    request: {
      query: z.object({
        lines: z.coerce.number().int().min(1).max(1000).optional().default(100),
        level: z.enum(["debug", "info", "warn", "error"]).optional(),
        ns: z.string().max(100).optional(),
        q: z.string().max(200).optional(),
        source: z.enum(["orc", "daemon", "all"]).optional().default("orc"),
      }),
    },
    responses: {
      200: {
        description: "Recent daemon log entries",
        content: {
          "application/json": {
            schema: z
              .object({
                path: z.string(),
                daemon_log_path: z.string(),
                entries: z.array(LogEntrySchema),
                total: z.number().int().nonnegative(),
              })
              .openapi("SystemLogs"),
          },
        },
      },
    },
  }),
  (c) => {
    const query = c.req.valid("query");
    c.header("Cache-Control", "no-store");
    return c.json(
      readRecentLogs({
        lines: query.lines,
        level: query.level,
        ns: query.ns,
        q: query.q,
        source: query.source,
      }),
      200,
    );
  },
);

export { app as systemRouter };
