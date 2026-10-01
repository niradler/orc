import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { NotFoundError } from "@orc/core/errors";
import { getDb } from "@orc/db/client";
import { gateway_sessions } from "@orc/db/schema";
import { and, eq } from "drizzle-orm";
import { LIVE_CHAT_ID } from "../session-watcher.js";
import { availableLaunchers, buildLaunch, LAUNCH_KINDS } from "../terminals/launch.js";
import {
  getTerminalManager,
  launchDeps,
  requireTerminals,
  terminalsAvailability,
} from "../terminals/service.js";

const app = new OpenAPIHono();

const LaunchKindSchema = z.enum(LAUNCH_KINDS);

const TerminalSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: LaunchKindSchema,
    cwd: z.string().nullable(),
    status: z.enum(["running", "exited"]),
    exit_code: z.number().nullable(),
    pid: z.number().nullable(),
    live_session_id: z.string().nullable(),
    created_at: z.string().datetime(),
  })
  .openapi("Terminal");

const idParam = z.object({ id: z.string() });

const listRoute = createRoute({
  method: "get",
  path: "/terminals",
  tags: ["Terminals"],
  summary: "List terminals and whether this server can start them",
  responses: {
    200: {
      description: "Terminals",
      content: {
        "application/json": {
          schema: z.object({
            enabled: z.boolean(),
            ready: z.boolean(),
            reason: z.string().nullable(),
            launchers: z.array(LaunchKindSchema),
            terminals: z.array(TerminalSchema),
          }),
        },
      },
    },
  },
});

const createTerminalRoute = createRoute({
  method: "post",
  path: "/terminals",
  tags: ["Terminals"],
  summary: "Start a terminal: a shell, a fresh coding agent, or a resumed live session",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            kind: LaunchKindSchema.optional(),
            cwd: z.string().min(1).optional(),
            name: z.string().max(120).optional(),
            live_session_id: z.string().min(1).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Existing terminal already attached to that live session",
      content: { "application/json": { schema: TerminalSchema } },
    },
    201: {
      description: "Terminal started",
      content: { "application/json": { schema: TerminalSchema } },
    },
  },
});

const getTerminalRoute = createRoute({
  method: "get",
  path: "/terminals/{id}",
  tags: ["Terminals"],
  summary: "Get a terminal",
  request: { params: idParam },
  responses: {
    200: { description: "Terminal", content: { "application/json": { schema: TerminalSchema } } },
  },
});

const deleteTerminalRoute = createRoute({
  method: "delete",
  path: "/terminals/{id}",
  tags: ["Terminals"],
  summary: "Kill a terminal's process and remove it",
  request: { params: idParam },
  responses: { 204: { description: "Removed" } },
});

const ticketRoute = createRoute({
  method: "post",
  path: "/terminals/{id}/ticket",
  tags: ["Terminals"],
  summary: "Mint a single-use WebSocket ticket for one terminal",
  request: { params: idParam },
  responses: {
    200: {
      description: "Ticket",
      content: {
        "application/json": {
          schema: z.object({ ticket: z.string(), expires_in: z.number() }),
        },
      },
    },
  },
});

app.openapi(listRoute, (c) => {
  const config = loadConfig();
  const { ready, reason } = terminalsAvailability(config);
  return c.json(
    {
      enabled: config.terminals.enabled,
      ready,
      reason,
      launchers: ready ? availableLaunchers(launchDeps(config)) : [],
      terminals: ready ? getTerminalManager().list() : [],
    },
    200,
  );
});

app.openapi(createTerminalRoute, async (c) => {
  const config = loadConfig();
  requireTerminals(config);
  const body = c.req.valid("json");
  const manager = getTerminalManager();
  const deps = launchDeps(config);

  if (body.live_session_id) {
    const existing = manager.findByLiveSession(body.live_session_id);
    if (existing) return c.json(existing, 200);
    const row = await getDb().query.gateway_sessions.findFirst({
      where: and(
        eq(gateway_sessions.id, body.live_session_id),
        eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
      ),
    });
    if (!row) throw new NotFoundError("Live session", body.live_session_id);
    const launch = buildLaunch(
      {
        live: {
          agent: row.backend,
          session_id: row.runtime_session_id ?? null,
          cwd: row.cwd ?? null,
        },
      },
      deps,
    );
    const info = manager.create({
      launch,
      name: body.name ?? row.title ?? undefined,
      liveSessionId: row.id,
    });
    return c.json(info, 201);
  }

  const launch = buildLaunch({ kind: body.kind, cwd: body.cwd }, deps);
  return c.json(manager.create({ launch, name: body.name }), 201);
});

app.openapi(getTerminalRoute, (c) => {
  requireTerminals(loadConfig());
  return c.json(getTerminalManager().get(c.req.valid("param").id), 200);
});

app.openapi(deleteTerminalRoute, (c) => {
  requireTerminals(loadConfig());
  getTerminalManager().remove(c.req.valid("param").id);
  return c.body(null, 204);
});

app.openapi(ticketRoute, (c) => {
  requireTerminals(loadConfig());
  return c.json(getTerminalManager().mintTicket(c.req.valid("param").id), 200);
});

export { app as terminalsRouter };
