import type { Database } from "bun:sqlite";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { NotFoundError } from "@orc/core/errors";
import { getDb } from "@orc/db/client";
import { sessions } from "@orc/db/schema";
import { and, desc, eq } from "drizzle-orm";

const app = new OpenAPIHono();

const SessionSchema = z
  .object({
    id: z.string(),
    agent: z.string(),
    agent_version: z.string().nullable(),
    project_id: z.string().nullable(),
    job_run_id: z.string().nullable(),
    summary: z.string().nullable(),
    tokens_used: z.number().nullable(),
    created_at: z.string().datetime(),
  })
  .openapi("Session");

const SessionDetailSchema = SessionSchema.extend({
  events: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      priority: z.number(),
      data: z.string(),
      created_at: z.string().datetime(),
    }),
  ),
  snapshot: z.string().nullable(),
}).openapi("SessionDetail");

const listRoute = createRoute({
  method: "get",
  path: "/sessions",
  tags: ["Sessions"],
  summary: "List recent sessions",
  request: {
    query: z.object({
      agent: z.string().optional(),
      job_run_id: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: "Sessions list",
      content: {
        "application/json": { schema: z.object({ sessions: z.array(SessionSchema) }) },
      },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/sessions/{id}",
  tags: ["Sessions"],
  summary: "Get session detail with events",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Session detail",
      content: { "application/json": { schema: SessionDetailSchema } },
    },
    404: { description: "Not found" },
  },
});

function toDto(s: typeof sessions.$inferSelect) {
  return {
    id: s.id,
    agent: s.agent,
    agent_version: s.agent_version ?? null,
    project_id: s.project_id ?? null,
    job_run_id: s.job_run_id ?? null,
    summary: s.summary ?? null,
    tokens_used: s.tokens_used ?? null,
    created_at: s.created_at.toISOString(),
  };
}

app.openapi(listRoute, async (c) => {
  const db = getDb();
  const { agent, job_run_id, limit } = c.req.valid("query");

  const conditions = [];
  if (agent) conditions.push(eq(sessions.agent, agent));
  if (job_run_id) conditions.push(eq(sessions.job_run_id, job_run_id));

  const rows = await db.query.sessions.findMany({
    limit,
    orderBy: [desc(sessions.created_at)],
    where: conditions.length > 0 ? and(...conditions) : undefined,
  });

  return c.json({ sessions: rows.map(toDto) });
});

app.openapi(getRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");

  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
  if (!session) throw new NotFoundError("Session", id);

  const sqlite = (db as unknown as { $client: Database }).$client;

  type EventRow = {
    id: string;
    type: string;
    priority: number;
    data: string;
    created_at: number;
  };

  const events = sqlite
    .query<EventRow, string>(
      `SELECT id, type, priority, data, created_at
       FROM session_events WHERE session_id = ?
       ORDER BY created_at ASC`,
    )
    .all(id);

  const snap = sqlite
    .query<{ xml: string }, string>(
      "SELECT xml FROM session_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(id);

  return c.json({
    ...toDto(session),
    snapshot: snap?.xml ?? null,
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      priority: e.priority,
      data: e.data,
      created_at: new Date(e.created_at * 1000).toISOString(),
    })),
  });
});

export { app as sessionsRouter };
