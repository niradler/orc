import type { Database } from "bun:sqlite";
import { realpath } from "node:fs/promises";
import { posix, relative } from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import { NotFoundError, ValidationError } from "@orc/core/errors";
import { execHostFor, hostRuntime, resolveExecHost } from "@orc/core/exec-host";
import { SessionCacheUsageSchema } from "@orc/core/usage";
import { getDb } from "@orc/db/client";
import { gateway_sessions, session_handoffs, sessions, tasks } from "@orc/db/schema";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { previewSession } from "../desktop-preview/session.js";
import { checkoutFiles } from "../git/files.js";
import { gitStatus } from "../git/panel.js";
import { createRouter } from "../lib/router.js";
import { LIVE_CHAT_ID, sessionWaitingForHuman, syncNow } from "../session-watcher.js";
import { emptySessionCacheUsage, loadSessionCacheUsage } from "../sessions/cache-usage.js";
import { searchSessions } from "../sessions/search.js";
import { bodyLinkIndex, sessionIdsOfTask } from "../sessions/tasklinks.js";
import { readTranscriptBytes } from "../sessions/transcript.js";
import { loadTranscriptBytes, transcriptCacheKey } from "../sessions/transcript-source.js";

const app = createRouter();

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

const LiveSessionSchema = z
  .object({
    id: z.string(),
    agent: z.string(),
    session_id: z.string().nullable(),
    name: z.string().nullable(),
    summary: z.string().nullable(),
    tokens_used: z.number().nullable(),
    tokens_estimated: z.boolean(),
    cwd: z.string().nullable(),
    host: z.string().nullable(),
    pid: z.number().nullable(),
    status: z.enum(["idle", "running", "stopped", "error"]),
    waiting_for_human: z.boolean().default(false),
    hidden: z.boolean().default(false),
    renamed: z.boolean().default(false),
    project_id: z.string().nullable(),
    task: z.object({ id: z.string(), title: z.string(), status: z.string() }).nullable(),
    handoff: z
      .object({
        id: z.string(),
        branch: z.string(),
        commit: z.string(),
        status: z.enum(["ready", "resumed"]),
      })
      .nullable(),
    last_activity_at: z.string().datetime().nullable(),
    created_at: z.string().datetime(),
  })
  .openapi("LiveSession");

const liveListRoute = createRoute({
  method: "get",
  path: "/sessions/live",
  tags: ["Sessions"],
  summary: "List coding-agent sessions seen by the file watcher",
  request: {
    query: z.object({
      agent: z.string().optional(),
      task_id: z.string().optional(),
      project_id: z.string().min(1).max(200).optional().openapi({
        description:
          "Project id, or unassigned for sessions without a project; filtered before limit",
      }),
      active: z
        .enum(["true", "false"])
        .optional()
        .default("true")
        .transform((v) => v === "true"),
      include_hidden: z
        .enum(["true", "false"])
        .optional()
        .default("false")
        .transform((v) => v === "true")
        .openapi({ description: "Include sessions a human hid from the list" }),
      limit: z.coerce.number().int().min(1).max(5000).optional().default(100),
    }),
  },
  responses: {
    200: {
      description: "Live sessions",
      content: {
        "application/json": {
          schema: z.object({ sessions: z.array(LiveSessionSchema) }),
        },
      },
    },
  },
});

const liveSearchRoute = createRoute({
  method: "get",
  path: "/sessions/live/search",
  tags: ["Sessions"],
  summary: "Search sessions by title, summary, directory and transcript content (ripgrep)",
  request: {
    query: z.object({
      q: z.string().min(2),
      agent: z.string().optional(),
      project_id: z.string().min(1).max(200).optional(),
      include_hidden: z
        .enum(["true", "false"])
        .optional()
        .default("false")
        .transform((v) => v === "true")
        .openapi({ description: "Include sessions a human hid from the list" }),
      limit: z.coerce.number().int().min(1).max(500).optional().default(100),
    }),
  },
  responses: {
    200: {
      description: "Ranked hits",
      content: {
        "application/json": {
          schema: z.object({
            rg: z.boolean(),
            ms: z.number(),
            hits: z.array(
              LiveSessionSchema.extend({
                score: z.number(),
                matched: z.array(z.string()),
                snippets: z.array(z.string()),
              }),
            ),
          }),
        },
      },
    },
  },
});

const TranscriptBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    name: z.string(),
    input: z.string(),
    id: z.string().optional(),
    result: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    text: z.string(),
    forId: z.string().optional(),
  }),
]);

const liveTranscriptRoute = createRoute({
  method: "get",
  path: "/sessions/live/{id}/transcript",
  tags: ["Sessions"],
  summary: "Read a session's conversation history, paged, with in-session match indexes",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      offset: z.coerce.number().int().min(0).optional().default(0),
      limit: z.coerce.number().int().min(1).max(500).optional().default(100),
      q: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "A page of turns",
      content: {
        "application/json": {
          schema: z.object({
            total: z.number(),
            offset: z.number(),
            matches: z.array(z.number()),
            turns: z.array(
              z.object({
                index: z.number(),
                role: z.enum(["user", "assistant", "tool", "system"]),
                time: z.string().nullable(),
                blocks: z.array(TranscriptBlockSchema),
              }),
            ),
          }),
        },
      },
    },
    404: { description: "Session not found, or it has no readable transcript" },
  },
});

const liveSyncRoute = createRoute({
  method: "post",
  path: "/sessions/live/sync",
  tags: ["Sessions"],
  summary: "Re-import sessions from every coding agent now",
  responses: {
    200: {
      description: "Per-agent import result",
      content: {
        "application/json": {
          schema: z.object({
            results: z.array(
              z.object({
                backend: z.string(),
                seen: z.number(),
                ms: z.number(),
                error: z.string().optional(),
              }),
            ),
          }),
        },
      },
    },
  },
});

const liveUpdateRoute = createRoute({
  method: "patch",
  path: "/sessions/live/{id}",
  tags: ["Sessions"],
  summary: "Rename, hide or link a live session",
  description:
    "Send any of task_id (null unlinks), display_title (null restores the agent's title) or hidden. A rename and a hide survive re-sync and restart.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            task_id: z.string().nullable().optional(),
            display_title: z.string().trim().min(1).max(200).nullable().optional(),
            hidden: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated session",
      content: { "application/json": { schema: LiveSessionSchema } },
    },
    404: { description: "Session or task not found" },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/sessions",
  tags: ["Sessions"],
  summary: "List recent sessions",
  request: {
    query: z.object({
      agent: z.string().optional(),
      job_run_id: z.string().optional(),
      project_id: z.string().optional(),
      order: z.enum(["asc", "desc"]).optional().default("desc"),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      offset: z.coerce.number().int().min(0).optional().default(0),
    }),
  },
  responses: {
    200: {
      description: "Sessions list",
      content: {
        "application/json": {
          schema: z.object({
            sessions: z.array(SessionSchema),
            total: z.number().int(),
          }),
        },
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

type GatewayRow = typeof gateway_sessions.$inferSelect;

async function toLiveDtos(rows: GatewayRow[]) {
  const handoffs = rows.length
    ? await getDb().query.session_handoffs.findMany({
        where: inArray(
          session_handoffs.live_session_id,
          rows.map((row) => row.id),
        ),
      })
    : [];
  const handoffsBySession = new Map(handoffs.map((row) => [row.live_session_id, row]));
  const taskIds = [...new Set(rows.map((r) => r.task_id).filter((id): id is string => !!id))];
  const linked =
    taskIds.length > 0
      ? await getDb().query.tasks.findMany({
          where: inArray(tasks.id, taskIds),
        })
      : [];
  const byId = new Map(linked.map((t) => [t.id, t]));
  const fromBody = await bodyLinkIndex();
  return rows.map((r) => {
    const handoff = handoffsBySession.get(r.id);
    const t = r.task_id
      ? byId.get(r.task_id)
      : fromBody.get((r.runtime_session_id ?? "").toLowerCase());
    return {
      id: r.id,
      agent: r.backend,
      session_id: r.runtime_session_id ?? null,
      name: r.display_title ?? r.title ?? null,
      summary: r.summary ?? null,
      tokens_used: r.tokens_used ?? null,
      tokens_estimated: r.backend === "cursor" && r.tokens_used != null,
      cwd: r.cwd ?? null,
      host: r.execution_host ?? null,
      pid: r.pid ?? null,
      status: r.status,
      waiting_for_human: sessionWaitingForHuman(
        r.backend,
        r.execution_host ?? null,
        r.runtime_session_id ?? null,
      ),
      hidden: r.hidden_at != null,
      renamed: r.display_title != null,
      project_id: r.project_id ?? null,
      handoff:
        handoff && (handoff.status === "ready" || handoff.status === "resumed")
          ? {
              id: handoff.id,
              branch: handoff.request.branch,
              commit: handoff.request.commit,
              status: handoff.status,
            }
          : null,
      task: t ? { id: t.id, title: t.title, status: t.status } : null,
      last_activity_at: r.last_activity_at?.toISOString() ?? null,
      created_at: r.created_at.toISOString(),
    };
  });
}

app.openapi(liveListRoute, async (c) => {
  const { agent, task_id, active, include_hidden, limit, project_id } = c.req.valid("query");
  const bodyIds = task_id ? await sessionIdsOfTask(task_id) : [];
  const rows = await getDb().query.gateway_sessions.findMany({
    where: and(
      eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
      include_hidden ? undefined : isNull(gateway_sessions.hidden_at),
      project_id === "unassigned"
        ? isNull(gateway_sessions.project_id)
        : project_id
          ? eq(gateway_sessions.project_id, project_id)
          : undefined,
      agent ? eq(gateway_sessions.backend, agent) : undefined,
      task_id
        ? or(
            eq(gateway_sessions.task_id, task_id),
            bodyIds.length > 0
              ? and(
                  isNull(gateway_sessions.task_id),
                  inArray(gateway_sessions.runtime_session_id, bodyIds),
                )
              : undefined,
          )
        : undefined,
      active
        ? or(
            ne(gateway_sessions.status, "stopped"),
            sql`EXISTS (SELECT 1 FROM session_handoffs h WHERE h.live_session_id = ${gateway_sessions.id} AND h.status = 'ready')`,
          )
        : undefined,
    ),
    orderBy: [desc(gateway_sessions.last_activity_at)],
    limit,
  });
  return c.json({ sessions: await toLiveDtos(rows) });
});

app.openapi(liveSearchRoute, async (c) => {
  const { q, agent, limit, project_id, include_hidden } = c.req.valid("query");
  const result = await searchSessions({
    q,
    agent,
    limit,
    projectId: project_id,
    includeHidden: include_hidden,
    runtime: hostRuntime(resolveExecHost()),
  });
  const dtos = await toLiveDtos(result.hits.map((h) => h.row));
  return c.json(
    {
      rg: result.rg,
      ms: result.ms,
      hits: result.hits.map((h, i) => ({
        ...(dtos[i] as NonNullable<(typeof dtos)[number]>),
        score: h.score,
        matched: h.matched,
        snippets: h.snippets,
      })),
    },
    200,
  );
});

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/live/{id}/cache",
    tags: ["Sessions"],
    summary: "Read recorded prompt-cache usage for a native session",
    request: { params: z.object({ id: z.string().min(1).max(200) }) },
    responses: {
      200: {
        description:
          "Numeric cache usage; absent evidence is null and timing is only a cautious hint",
        content: { "application/json": { schema: SessionCacheUsageSchema } },
      },
      404: { description: "Session not found" },
      503: { description: "Cache data could not be read" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const row = await getDb().query.gateway_sessions.findFirst({
      where: and(eq(gateway_sessions.id, id), eq(gateway_sessions.chat_id, LIVE_CHAT_ID)),
    });
    if (!row) throw new NotFoundError("Session", id);
    c.header("Cache-Control", "no-store");
    if (!row.transcript_path || (row.backend !== "claude" && row.backend !== "codex"))
      return c.json(emptySessionCacheUsage(), 200);
    const runtime = hostRuntime(execHostFor(row.execution_host ?? null));
    return c.json(await loadSessionCacheUsage(runtime, row.backend, row.transcript_path), 200);
  },
);

app.openapi(liveTranscriptRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { offset, limit, q } = c.req.valid("query");
  const row = await getDb().query.gateway_sessions.findFirst({
    where: and(eq(gateway_sessions.id, id), eq(gateway_sessions.chat_id, LIVE_CHAT_ID)),
  });
  if (!row) throw new NotFoundError("Session", id);
  if (!row.transcript_path) {
    throw new NotFoundError("Transcript for session", id);
  }
  const runtime = hostRuntime(execHostFor(row.execution_host ?? null));
  if (!(await runtime.isFile(row.transcript_path)))
    throw new NotFoundError("Transcript for session", id);
  const externalId = row.runtime_session_id ?? null;
  const bytes = await loadTranscriptBytes(runtime, row.backend, row.transcript_path, externalId);
  const host = runtime.host.kind === "ssh" ? runtime.host.alias : "local";
  return c.json(
    await readTranscriptBytes(
      bytes,
      row.backend,
      transcriptCacheKey(host, row.backend, row.transcript_path, externalId),
      {
        offset,
        limit,
        q,
      },
    ),
    200,
  );
});

app.openapi(liveSyncRoute, async (c) => c.json({ results: await syncNow() }, 200));

app.openapi(liveUpdateRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const { task_id, display_title, hidden } = c.req.valid("json");
  if (task_id === undefined && display_title === undefined && hidden === undefined)
    throw new ValidationError("Send task_id, display_title or hidden");
  const row = await db.query.gateway_sessions.findFirst({
    where: and(eq(gateway_sessions.id, id), eq(gateway_sessions.chat_id, LIVE_CHAT_ID)),
  });
  if (!row) throw new NotFoundError("Session", id);
  if (task_id && !(await db.query.tasks.findFirst({ where: eq(tasks.id, task_id) }))) {
    throw new NotFoundError("Task", task_id);
  }
  const patch: Partial<typeof gateway_sessions.$inferInsert> = {};
  if (task_id !== undefined) patch.task_id = task_id;
  if (display_title !== undefined) patch.display_title = display_title;
  if (hidden !== undefined) patch.hidden_at = hidden ? (row.hidden_at ?? new Date()) : null;
  await db
    .update(gateway_sessions)
    .set({ ...patch, updated_at: new Date() })
    .where(eq(gateway_sessions.id, id));
  const [dto] = await toLiveDtos([
    {
      ...row,
      ...(task_id !== undefined ? { task_id } : {}),
      ...(display_title !== undefined ? { display_title } : {}),
      ...(hidden !== undefined ? { hidden_at: patch.hidden_at ?? null } : {}),
    },
  ]);
  return c.json(dto as NonNullable<typeof dto>, 200);
});

app.openapi(listRoute, async (c) => {
  const db = getDb();
  const { agent, job_run_id, project_id, limit, offset, order } = c.req.valid("query");

  const conditions = [];
  if (agent) conditions.push(eq(sessions.agent, agent));
  if (job_run_id) conditions.push(eq(sessions.job_run_id, job_run_id));
  if (project_id === "unassigned") conditions.push(isNull(sessions.project_id));
  else if (project_id) conditions.push(eq(sessions.project_id, project_id));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db.query.sessions.findMany({
    limit,
    offset,
    orderBy:
      order === "asc"
        ? [asc(sessions.created_at), asc(sessions.id)]
        : [desc(sessions.created_at), desc(sessions.id)],
    where,
  });
  const [counted] = await db.select({ total: sql<number>`count(*)` }).from(sessions).where(where);

  return c.json({
    sessions: rows.map(toDto),
    total: Number(counted?.total ?? 0),
  });
});

app.openapi(getRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, id),
  });
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

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/{id}/files",
    tags: ["Sessions"],
    summary: "Browse files inside a session workspace",
    request: {
      params: z.object({ id: z.string().min(1).max(200) }),
      query: z.object({ path: z.string().max(4096).default("") }),
    },
    responses: {
      200: {
        description: "Workspace files",
        content: {
          "application/json": {
            schema: z.object({
              root: z.string(),
              path: z.string(),
              entries: z
                .array(z.object({ name: z.string(), path: z.string(), directory: z.boolean() }))
                .nullable(),
              content: z.string().nullable(),
              binary: z.boolean(),
              truncated: z.boolean(),
            }),
          },
        },
      },
      404: { description: "Session not found" },
    },
  }),
  async (c) => {
    const session = await previewSession(c.req.valid("param").id);
    const cwd = session.host.kind === "local" ? await realpath(session.cwd) : session.cwd;
    const root = (await gitStatus(session.host, cwd)).root ?? cwd;
    const path =
      c.req.valid("query").path ||
      (session.host.kind === "ssh" ? posix.relative : relative)(root, cwd);
    return c.json(await checkoutFiles(session.host, session.cwd, path), 200);
  },
);

export { app as sessionsRouter };
