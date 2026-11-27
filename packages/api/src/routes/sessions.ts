import type { Database } from "bun:sqlite";
import { realpath } from "node:fs/promises";
import { posix, relative } from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import { type ChatThread, NATIVE_CHAT_AGENTS } from "@orc/core/chat";
import { ChatAnalyticsSchema } from "@orc/core/chat-analytics";
import { ForbiddenError, NotFoundError, ValidationError } from "@orc/core/errors";
import { execHostFor, hostRuntime, resolveExecHost } from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import {
  type SessionListItem,
  SessionListResponseSchema,
  SessionListScopeSchema,
  SessionUpdateSchema,
  sessionMessageBackend,
} from "@orc/core/session-messages";
import { SessionCacheUsageSchema } from "@orc/core/usage";
import { ChatStore } from "@orc/db/chat";
import { getDb, getSqlite } from "@orc/db/client";
import { gateway_sessions, projects, session_handoffs, sessions, tasks } from "@orc/db/schema";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { previewSession } from "../desktop-preview/session.js";
import { checkoutFiles } from "../git/files.js";
import { gitStatus } from "../git/panel.js";
import { latestSendsFor, sendDto } from "../handoffs/send.js";
import { createRouter } from "../lib/router.js";
import { LIVE_CHAT_ID, liveRunFields, syncNow } from "../session-watcher.js";
import { emptySessionCacheUsage, loadSessionCacheUsage } from "../sessions/cache-usage.js";
import { chatAnalyticsFor } from "../sessions/chat-analytics.js";
import { childWorkCountsMany, spawnChain } from "../sessions/control.js";
import { chatThreadTranscript, resolveSessionRef } from "../sessions/resolve.js";
import { searchSessions } from "../sessions/search.js";
import { bodyLinkIndex, sessionIdsOfTask } from "../sessions/tasklinks.js";
import { readTranscriptBytes } from "../sessions/transcript.js";
import { loadTranscriptBytes, transcriptCacheKey } from "../sessions/transcript-source.js";
import { chatControl } from "../sessions/turns.js";
import { chatStatus } from "./chat.js";

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
    parent_id: z.string().nullable().default(null).openapi({
      description: "Live session id of the session that spawned this subagent",
    }),
    spawned_from_id: z.string().nullable().default(null).openapi({
      description:
        "Live session id of the session that started this one as an independent session (Claude Desktop start_session)",
    }),
    name: z.string().nullable(),
    summary: z.string().nullable(),
    tokens_used: z.number().nullable(),
    tokens_estimated: z.boolean(),
    model: z.string().nullable().default(null),
    permission_mode: z.string().nullable().default(null),
    cwd: z.string().nullable(),
    host: z.string().nullable(),
    pid: z.number().nullable(),
    status: z.enum(["idle", "running", "stopped", "error"]),
    waiting_for_human: z.boolean().default(false),
    waiting_for: z
      .object({
        reason: z.enum(["permission", "question", "dialog"]),
        tool: z.string().nullable(),
      })
      .nullable()
      .default(null)
      .openapi({ description: "Why the session waits for a human, and the tool that waits" }),
    background_work: z.boolean().default(false).openapi({
      description: "Idle between turns while the agent's background work still runs",
    }),
    working_children: z.number().int().default(0).openapi({
      description: "Child sessions and native subagents with a turn in flight",
    }),
    waiting_children: z.number().int().default(0).openapi({
      description: "Child sessions parked on a human question or approval",
    }),
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
    send: z
      .object({
        id: z.string(),
        status: z.enum(["preparing", "ready", "error"]),
        host_label: z.string(),
        host_url: z.string(),
        remote_session_id: z.string().nullable(),
        error: z.string().nullable(),
      })
      .nullable()
      .openapi({ description: "The latest move of this session to another ORC installation" }),
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
      include_children: z
        .enum(["true", "false"])
        .optional()
        .default("false")
        .transform((v) => v === "true")
        .openapi({
          description:
            "Also return the subagent sessions of the listed sessions; limit counts top-level sessions only",
        }),
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

const liveListUnifiedRoute = createRoute({
  method: "get",
  path: "/sessions/live/list",
  tags: ["Sessions"],
  summary: "List unified ORC chat and discovered native sessions with filters and pagination",
  request: {
    query: z.object({
      scope: SessionListScopeSchema.optional().default("all"),
      parent: z.string().min(1).max(200).optional(),
      project_id: z.string().min(1).max(200).optional(),
      project_ids: z.string().optional(),
      agent: z.string().min(1).max(64).optional(),
      host: z.string().min(1).max(255).optional(),
      status: z.string().min(1).max(32).optional(),
      q: z.string().trim().min(1).max(200).optional(),
      include_hidden: z
        .enum(["true", "false"])
        .optional()
        .transform((v) => v === "true"),
      include_subagents: z
        .enum(["true", "false"])
        .optional()
        .transform((v) => v === "true"),
      sync: z
        .enum(["true", "false"])
        .optional()
        .transform((v) => v === "true"),
      limit: z.coerce.number().int().min(1).max(100).optional().default(25),
      offset: z.coerce.number().int().min(0).optional().default(0),
    }),
  },
  responses: {
    200: {
      description: "Unified paginated session list",
      content: { "application/json": { schema: SessionListResponseSchema } },
    },
  },
});

const liveGetRoute = createRoute({
  method: "get",
  path: "/sessions/live/{id}",
  tags: ["Sessions"],
  summary: "Read one discovered session",
  request: { params: z.object({ id: z.string().min(1).max(200) }) },
  responses: {
    200: {
      description: "Session",
      content: { "application/json": { schema: LiveSessionSchema } },
    },
    404: { description: "Session not found" },
  },
});

const liveUpdateRoute = createRoute({
  method: "patch",
  path: "/sessions/live/{id}",
  tags: ["Sessions"],
  summary: "Update a chat or discovered session",
  description:
    "Update title/display_title, hidden, task_id (discovered sessions), or chat settings (model, effort, permission_mode, send_while_running).",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: SessionUpdateSchema,
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

const CreateSessionSchema = z
  .object({
    agent: z.string().trim().min(1).max(100),
    agent_version: z.string().max(100).optional(),
    project: z.string().max(200).optional(),
    project_id: z.string().max(200).optional(),
    summary: z.string().max(10_000).optional(),
    tokens_used: z.number().int().nonnegative().optional(),
  })
  .openapi("CreateSession");

const createSessionRoute = createRoute({
  method: "post",
  path: "/sessions",
  tags: ["Sessions"],
  summary: "Record a session log entry",
  request: {
    body: {
      content: { "application/json": { schema: CreateSessionSchema } },
    },
  },
  responses: {
    201: {
      description: "Created session log entry",
      content: { "application/json": { schema: SessionSchema } },
    },
    404: { description: "Project not found" },
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

const nativeKey = (backend: string, host: string | null, runtimeId: string | null) =>
  JSON.stringify([backend, host, runtimeId]);

async function toLiveDtos(rows: GatewayRow[]) {
  const parentIds = [
    ...new Set(
      rows.flatMap((row) =>
        [row.parent_session_id, row.spawned_from_session_id].filter((id): id is string => !!id),
      ),
    ),
  ];
  const parents = parentIds.length
    ? await getDb().query.gateway_sessions.findMany({
        where: and(
          eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
          inArray(gateway_sessions.runtime_session_id, parentIds),
        ),
        columns: { id: true, backend: true, execution_host: true, runtime_session_id: true },
      })
    : [];
  const parentByNative = new Map(
    parents.map((row) => [
      nativeKey(row.backend, row.execution_host ?? null, row.runtime_session_id),
      row.id,
    ]),
  );
  const handoffs = rows.length
    ? await getDb().query.session_handoffs.findMany({
        where: inArray(
          session_handoffs.live_session_id,
          rows.map((row) => row.id),
        ),
      })
    : [];
  const handoffsBySession = new Map(handoffs.map((row) => [row.live_session_id, row]));
  const sendsBySession = await latestSendsFor(rows.map((row) => row.id));
  const taskIds = [...new Set(rows.map((r) => r.task_id).filter((id): id is string => !!id))];
  const linked =
    taskIds.length > 0
      ? await getDb().query.tasks.findMany({
          where: inArray(tasks.id, taskIds),
        })
      : [];
  const byId = new Map(linked.map((t) => [t.id, t]));
  const fromBody = await bodyLinkIndex();
  const childWork = childWorkCountsMany(
    rows.map((r) => ({
      id: r.id,
      nativeId: r.runtime_session_id,
      backend: r.backend,
      host: r.execution_host,
    })),
  );
  return rows.map((r) => {
    const handoff = handoffsBySession.get(r.id);
    const sendRow = sendsBySession.get(r.id);
    const send = sendRow ? sendDto(sendRow) : null;
    const t = r.task_id
      ? byId.get(r.task_id)
      : fromBody.get((r.runtime_session_id ?? "").toLowerCase());
    return {
      id: r.id,
      agent: r.backend,
      session_id: r.runtime_session_id ?? null,
      parent_id: r.parent_session_id
        ? (parentByNative.get(
            nativeKey(r.backend, r.execution_host ?? null, r.parent_session_id),
          ) ?? null)
        : null,
      spawned_from_id: r.spawned_from_session_id
        ? (parentByNative.get(
            nativeKey(r.backend, r.execution_host ?? null, r.spawned_from_session_id),
          ) ?? null)
        : null,
      name: r.display_title ?? r.title ?? null,
      summary: r.summary ?? null,
      tokens_used: r.tokens_used ?? null,
      tokens_estimated: r.backend === "cursor" && r.tokens_used != null,
      model: r.model ?? null,
      permission_mode: r.permission_mode ?? null,
      cwd: r.cwd ?? null,
      host: r.execution_host ?? null,
      pid: r.pid ?? null,
      status: r.status,
      ...liveRunFields(r.backend, r.execution_host ?? null, r.runtime_session_id ?? null),
      working_children: childWork.get(r.id)?.working ?? 0,
      waiting_children: childWork.get(r.id)?.waiting ?? 0,
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
      send: send
        ? {
            id: send.id,
            status: send.status,
            host_label: send.host_label,
            host_url: send.host_url,
            remote_session_id: send.remote_session_id,
            error: send.error,
          }
        : null,
      task: t ? { id: t.id, title: t.title, status: t.status } : null,
      last_activity_at: r.last_activity_at?.toISOString() ?? null,
      created_at: r.created_at.toISOString(),
    };
  });
}

app.openapi(liveListRoute, async (c) => {
  const { agent, task_id, active, include_hidden, include_children, limit, project_id } =
    c.req.valid("query");
  const bodyIds = task_id ? await sessionIdsOfTask(task_id) : [];
  const rows = await getDb().query.gateway_sessions.findMany({
    where: and(
      eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
      isNull(gateway_sessions.parent_session_id),
      include_hidden ? undefined : isNull(gateway_sessions.hidden_at),
      sql`NOT (coalesce(${gateway_sessions.tokens_used}, -1) = 0 AND ${gateway_sessions.summary} IS NULL)`,
      task_id
        ? undefined
        : or(
            isNotNull(gateway_sessions.transcript_path),
            ne(gateway_sessions.status, "stopped"),
            notInArray(gateway_sessions.backend, NATIVE_CHAT_AGENTS),
          ),
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
            sql`EXISTS (SELECT 1 FROM session_sends s WHERE s.live_session_id = ${gateway_sessions.id} AND s.status = 'ready')`,
          )
        : undefined,
    ),
    orderBy: [desc(gateway_sessions.last_activity_at)],
    limit,
  });
  const listed = new Set(
    rows.map((row) => nativeKey(row.backend, row.execution_host ?? null, row.runtime_session_id)),
  );
  const children: typeof rows = [];
  let level = rows;
  while (include_children && level.length) {
    const parentIds = [...new Set(level.flatMap((row) => row.runtime_session_id ?? []))];
    level = parentIds.length
      ? (
          await getDb().query.gateway_sessions.findMany({
            where: and(
              eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
              include_hidden ? undefined : isNull(gateway_sessions.hidden_at),
              inArray(gateway_sessions.parent_session_id, parentIds),
            ),
            orderBy: [desc(gateway_sessions.last_activity_at)],
          })
        ).filter(
          (row) =>
            listed.has(nativeKey(row.backend, row.execution_host ?? null, row.parent_session_id)) &&
            !listed.has(nativeKey(row.backend, row.execution_host ?? null, row.runtime_session_id)),
        )
      : [];
    for (const row of level)
      listed.add(nativeKey(row.backend, row.execution_host ?? null, row.runtime_session_id));
    children.push(...level);
  }
  return c.json({ sessions: await toLiveDtos([...rows, ...children]) });
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

function normalizeHost(host: string | null | undefined): string {
  const value = host?.trim() ?? "";
  return !value || value === "local" ? "local" : value;
}

function threadToLiveDto(thread: ChatThread): z.infer<typeof LiveSessionSchema> {
  const st = chatStatus(thread.id);
  const createdMs = thread.spawnedBy?.at ?? thread.messages[0]?.timestamp ?? thread.updatedAt;
  const liveStatus: "idle" | "running" | "stopped" | "error" =
    st.status === "running" || st.status === "waiting" || st.status === "queued"
      ? "running"
      : st.status === "failed"
        ? "error"
        : st.status === "stopped"
          ? "stopped"
          : "idle";
  return {
    id: thread.id,
    agent: thread.config.agent,
    session_id: thread.runtimeId ?? null,
    parent_id: null,
    spawned_from_id: thread.spawnedBy?.sessionId ?? null,
    name: thread.title,
    summary: st.last_message,
    tokens_used: null,
    tokens_estimated: false,
    model: thread.config.model || null,
    permission_mode: thread.config.permissionMode ?? null,
    cwd: thread.cwd,
    host: thread.host,
    pid: null,
    status: liveStatus,
    waiting_for_human: st.waiting_for !== null,
    waiting_for:
      st.waiting_for === "question"
        ? { reason: "question" as const, tool: null }
        : st.waiting_for === "approval"
          ? { reason: "permission" as const, tool: null }
          : null,
    background_work: false,
    working_children: st.working_children,
    waiting_children: st.waiting_children,
    hidden: !!thread.hidden,
    renamed: false,
    project_id: thread.projectId ?? null,
    handoff: null,
    send: null,
    task: null,
    last_activity_at: new Date(st.last_activity_at ?? st.updated_at).toISOString(),
    created_at: new Date(createdMs).toISOString(),
  };
}

app.openapi(liveListUnifiedRoute, async (c) => {
  const {
    scope,
    parent,
    project_id,
    project_ids,
    agent,
    host,
    status,
    q,
    include_hidden,
    include_subagents,
    sync,
    limit,
    offset,
  } = c.req.valid("query");
  if (sync) await syncNow();

  let parentKeys: Set<string> | null = null;
  const requestedParent =
    parent === "self" || (!parent && scope === "children")
      ? c.req.header("x-orc-session")?.trim() || null
      : (parent ?? null);
  if (requestedParent) {
    const resolvedParent = resolveSessionRef(requestedParent);
    parentKeys = new Set(
      [
        requestedParent,
        resolvedParent?.thread?.id,
        resolvedParent?.gateway?.id,
        resolvedParent?.thread?.runtimeId,
        resolvedParent?.gateway?.runtime_session_id,
      ].filter((value): value is string => !!value),
    );
  } else if (scope === "children") {
    return c.json(
      { sessions: [], total: 0, offset, limit, has_more: false, next_offset: null },
      200,
    );
  }

  const chatRows =
    scope === "native"
      ? []
      : getSqlite()
          .query<
            {
              id: string;
              title: string;
              updatedAt: number;
              agent: string | null;
              backend: string | null;
              runtimeId: string | null;
              runtimeModel: string | null;
              model: string | null;
              sourceId: string | null;
              host: string | null;
              cwd: string | null;
              projectId: string | null;
              spawnedFrom: string | null;
              hidden: number;
              queued: number;
            },
            []
          >(
            `SELECT id, title, updated_at AS updatedAt,
              CASE WHEN json_valid(data) AND json_type(data, '$.config.agent') = 'text'
                THEN json_extract(data, '$.config.agent') END AS agent,
              CASE WHEN json_valid(data) AND json_type(data, '$.backend') = 'text'
                THEN json_extract(data, '$.backend') END AS backend,
              CASE WHEN json_valid(data) AND json_type(data, '$.runtimeId') = 'text'
                THEN json_extract(data, '$.runtimeId') END AS runtimeId,
              CASE WHEN json_valid(data) AND json_type(data, '$.runtimeModel') = 'text'
                THEN json_extract(data, '$.runtimeModel') END AS runtimeModel,
              CASE WHEN json_valid(data) AND json_type(data, '$.config.model') = 'text'
                THEN json_extract(data, '$.config.model') END AS model,
              CASE WHEN json_valid(data) AND json_type(data, '$.sourceId') = 'text'
                THEN json_extract(data, '$.sourceId') END AS sourceId,
              CASE WHEN json_valid(data) AND json_type(data, '$.host') = 'text'
                THEN json_extract(data, '$.host') END AS host,
              CASE WHEN json_valid(data) AND json_type(data, '$.cwd') = 'text'
                THEN json_extract(data, '$.cwd') END AS cwd,
              CASE WHEN json_valid(data) AND json_type(data, '$.projectId') = 'text'
                THEN json_extract(data, '$.projectId') END AS projectId,
              CASE WHEN json_valid(data) AND json_type(data, '$.spawnedBy.sessionId') = 'text'
                THEN json_extract(data, '$.spawnedBy.sessionId') END AS spawnedFrom,
              CASE WHEN json_valid(data) AND json_extract(data, '$.hidden') = 1 THEN 1 ELSE 0 END AS hidden,
              CASE WHEN json_valid(data) AND json_extract(data, '$.spawnedBy.prompt') IS NOT NULL THEN 1 ELSE 0 END AS queued
            FROM chat_threads ORDER BY updated_at DESC`,
          )
          .all();
  const gatewayRows =
    scope === "chats"
      ? []
      : await getDb().query.gateway_sessions.findMany({
          where: eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
          orderBy: [desc(gateway_sessions.last_activity_at), desc(gateway_sessions.updated_at)],
          limit: 500,
        });

  const gatewayById = new Map(gatewayRows.map((row) => [row.id, row]));
  const gatewayByRuntime = new Map<string, (typeof gatewayRows)[number]>();
  for (const row of gatewayRows) {
    if (!row.runtime_session_id) continue;
    const key = `${sessionMessageBackend(row.backend)}\0${normalizeHost(row.execution_host)}\0${row.runtime_session_id}`;
    if (!gatewayByRuntime.has(key)) gatewayByRuntime.set(key, row);
  }

  const mergedGatewayIds = new Set<string>();
  const items: SessionListItem[] = [];

  for (const chat of chatRows) {
    const linked =
      (chat.sourceId ? gatewayById.get(chat.sourceId) : undefined) ??
      (chat.runtimeId && (chat.backend || chat.agent)
        ? gatewayByRuntime.get(
            `${sessionMessageBackend(chat.backend ?? chat.agent ?? "")}\0${normalizeHost(chat.host)}\0${chat.runtimeId}`,
          )
        : undefined);
    if (linked) mergedGatewayIds.add(linked.id);
    const running = chatControl().running(chat.id);
    const waiting = running ? chatControl().waiting(chat.id) : null;
    const itemStatus = waiting ? "waiting" : running ? "running" : chat.queued ? "queued" : "idle";
    const updatedAt = Math.max(
      chat.updatedAt,
      linked?.last_activity_at?.getTime() ?? linked?.updated_at.getTime() ?? 0,
    );
    items.push({
      session_id: chat.id,
      source: "chat",
      title: chat.title || linked?.display_title || linked?.title || chat.id,
      agent: chat.agent ?? (chat.backend ? sessionMessageBackend(chat.backend) : null),
      model: chat.runtimeModel ?? (chat.model || null) ?? linked?.model ?? null,
      status: itemStatus,
      waiting_for: waiting,
      project_id: chat.projectId ?? linked?.project_id ?? null,
      cwd: chat.cwd ?? linked?.cwd ?? null,
      host: chat.host ?? linked?.execution_host ?? null,
      parent_session_id:
        chat.spawnedFrom ?? linked?.spawned_from_session_id ?? linked?.parent_session_id ?? null,
      working_children: 0,
      waiting_children: 0,
      native_session_id: chat.runtimeId ?? linked?.runtime_session_id ?? null,
      live_session_id: linked?.id ?? null,
      hidden: Boolean(chat.hidden || linked?.hidden_at != null),
      last_message: linked?.summary ? linked.summary.slice(0, 300) : null,
      updated_at: updatedAt,
      last_activity_at: linked?.last_activity_at?.getTime() ?? chat.updatedAt,
    });
  }

  for (const row of gatewayRows) {
    if (mergedGatewayIds.has(row.id)) continue;
    if (row.parent_session_id && !include_subagents && !parentKeys) continue;
    const live = liveRunFields(
      row.backend,
      row.execution_host ?? null,
      row.runtime_session_id ?? null,
    );
    const waitingFor = live.waiting_for?.reason ?? null;
    const updatedAt = row.last_activity_at?.getTime() ?? row.updated_at.getTime();
    items.push({
      session_id: row.id,
      source: "native",
      title: row.display_title ?? row.title ?? row.id,
      agent: sessionMessageBackend(row.backend),
      model: row.model ?? null,
      status: waitingFor ? "waiting" : row.status,
      waiting_for: waitingFor,
      project_id: row.project_id ?? null,
      cwd: row.cwd ?? null,
      host: row.execution_host ?? null,
      parent_session_id: row.spawned_from_session_id ?? row.parent_session_id ?? null,
      working_children: 0,
      waiting_children: 0,
      native_session_id: row.runtime_session_id ?? null,
      live_session_id: row.id,
      hidden: row.hidden_at != null,
      last_message: row.summary ? row.summary.slice(0, 300) : null,
      updated_at: updatedAt,
      last_activity_at: row.last_activity_at?.getTime() ?? null,
    });
  }

  const projectIdSet = project_ids
    ? new Set(
        project_ids
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      )
    : null;
  const agentFilter = agent ? sessionMessageBackend(agent) : null;
  const hostFilter = host ? normalizeHost(host) : null;
  const needle = q?.toLowerCase() ?? null;

  const filtered = items
    .filter((item) => {
      if (!include_hidden && item.hidden) return false;
      if (parentKeys && (!item.parent_session_id || !parentKeys.has(item.parent_session_id))) {
        return false;
      }
      if (project_id === "unassigned") {
        if (item.project_id !== null) return false;
      } else if (project_id) {
        if (item.project_id !== project_id) return false;
      } else if (projectIdSet && projectIdSet.size > 0) {
        if (!item.project_id || !projectIdSet.has(item.project_id)) return false;
      }
      if (agentFilter) {
        const itemAgent = item.agent ? sessionMessageBackend(item.agent) : "";
        if (itemAgent !== agentFilter && item.agent !== agent) return false;
      }
      if (hostFilter && normalizeHost(item.host) !== hostFilter) return false;
      if (status) {
        if (status === "active") {
          if (!["running", "waiting", "queued"].includes(item.status)) return false;
        } else if (item.status !== status) {
          return false;
        }
      }
      if (needle) {
        const hay = [
          item.title,
          item.cwd,
          item.session_id,
          item.native_session_id,
          item.last_message,
        ]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    })
    .sort((a, b) => b.updated_at - a.updated_at || a.session_id.localeCompare(b.session_id));

  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const childWork = childWorkCountsMany(
    page.map((item) => ({
      id: item.session_id,
      nativeId: item.native_session_id,
      backend: item.agent,
      host: item.host,
    })),
  );
  for (const item of page) {
    const counts = childWork.get(item.session_id);
    if (counts) {
      item.working_children = counts.working;
      item.waiting_children = counts.waiting;
    }
    if (item.source === "chat") {
      try {
        const st = chatStatus(item.session_id);
        item.status = st.status;
        item.waiting_for = st.waiting_for;
        item.working_children = st.working_children;
        item.waiting_children = st.waiting_children;
        item.last_message = st.last_message ? st.last_message.slice(0, 300) : item.last_message;
        item.last_activity_at = st.last_activity_at ?? item.last_activity_at;
      } catch {
        // Keep summary fields if thread payload is unreadable.
      }
    }
  }
  const hasMore = offset + page.length < total;
  return c.json(
    {
      sessions: page,
      total,
      offset,
      limit,
      has_more: hasMore,
      next_offset: hasMore ? offset + page.length : null,
    },
    200,
  );
});

// Registered after static /sessions/live/* routes: Hono matches in
// registration order, so {id} would otherwise swallow "search" or "list".
app.openapi(liveGetRoute, async (c) => {
  const { id } = c.req.valid("param");
  const resolved = resolveSessionRef(id);
  if (!resolved) throw new NotFoundError("Session", id);
  if (resolved.gateway) {
    const [session] = await toLiveDtos([resolved.gateway]);
    if (session) return c.json(session, 200);
  }
  if (!resolved.thread) throw new NotFoundError("Session", id);
  return c.json(threadToLiveDto(resolved.thread), 200);
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
    const resolved = resolveSessionRef(id);
    if (!resolved) throw new NotFoundError("Session", id);
    const row = resolved.gateway;
    c.header("Cache-Control", "no-store");
    if (!row?.transcript_path || !["claude", "codex", "pi", "opencode"].includes(row.backend))
      return c.json(emptySessionCacheUsage(), 200);
    const runtime = hostRuntime(execHostFor(row.execution_host ?? null));
    return c.json(
      await loadSessionCacheUsage(
        runtime,
        row.backend,
        row.transcript_path,
        row.runtime_session_id ?? null,
      ),
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/live/{id}/analytics",
    tags: ["Sessions"],
    summary: "Read chat, turn, tool, context and cache analytics for a native session",
    request: { params: z.object({ id: z.string().min(1).max(200) }) },
    responses: {
      200: {
        description: "Analytics for the chat that owns this native session",
        content: { "application/json": { schema: ChatAnalyticsSchema } },
      },
      404: { description: "Session, or its chat, not found" },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const resolved = resolveSessionRef(id);
    if (!resolved) throw new NotFoundError("Session", id);
    const row = resolved.gateway;
    const thread =
      resolved.thread ??
      (row
        ? (new ChatStore(getSqlite()).bySource(row.id) ??
          (row.runtime_session_id
            ? (new ChatStore(getSqlite()).byRuntime(
                row.backend,
                row.execution_host ?? null,
                row.runtime_session_id,
              )[0] ?? null)
            : null))
        : null);
    if (!thread) throw new NotFoundError("Chat for session", id);
    c.header("Cache-Control", "no-store");
    return c.json(
      await chatAnalyticsFor(thread, {
        backend: row?.backend ?? thread.backend,
        model: row?.model ?? (thread.config.model || null),
        transcript_path: row?.transcript_path ?? null,
        runtime_session_id: row?.runtime_session_id ?? thread.runtimeId ?? null,
        tokens_used: row?.tokens_used ?? null,
      }),
      200,
    );
  },
);

app.openapi(liveTranscriptRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { offset, limit, q } = c.req.valid("query");
  const resolved = resolveSessionRef(id);
  if (!resolved) throw new NotFoundError("Session", id);
  const row = resolved.gateway;
  if (row?.transcript_path) {
    const runtime = hostRuntime(execHostFor(row.execution_host ?? null));
    if (await runtime.isFile(row.transcript_path)) {
      const externalId = row.runtime_session_id ?? null;
      const bytes = await loadTranscriptBytes(
        runtime,
        row.backend,
        row.transcript_path,
        externalId,
      );
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
    }
  }
  if (resolved.thread) {
    return c.json(chatThreadTranscript(resolved.thread, { offset, limit, q }), 200);
  }
  throw new NotFoundError("Transcript for session", id);
});

app.openapi(liveSyncRoute, async (c) => c.json({ results: await syncNow() }, 200));

app.openapi(liveUpdateRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const nextTitle = body.title !== undefined ? body.title : body.display_title;
  const hasChatConfigPatch =
    body.model !== undefined ||
    body.effort !== undefined ||
    body.permission_mode !== undefined ||
    body.send_while_running !== undefined;
  const hasAnyPatch =
    body.task_id !== undefined ||
    nextTitle !== undefined ||
    body.hidden !== undefined ||
    hasChatConfigPatch;
  if (!hasAnyPatch) {
    throw new ValidationError(
      "Send at least one of title, display_title, hidden, task_id, model, effort, permission_mode or send_while_running",
    );
  }
  const resolved = resolveSessionRef(id);
  if (!resolved) throw new NotFoundError("Session", id);
  const row = resolved.gateway;
  const thread = resolved.thread;
  const callerId = c.req.header("X-ORC-Session")?.trim();
  if (callerId && body.hidden !== undefined) {
    const owned = thread
      ? thread.id === callerId ||
        thread.runtimeId === callerId ||
        spawnChain(thread.id).includes(callerId)
      : !!row && (row.id === callerId || row.runtime_session_id === callerId);
    if (!owned) {
      throw new ForbiddenError("Only a session or its ancestor can hide or unhide it");
    }
  }
  if (hasChatConfigPatch && !thread) {
    throw new ValidationError(
      "model, effort, permission_mode and send_while_running can only be updated on ORC chat sessions",
    );
  }
  if (body.task_id !== undefined && !row) {
    throw new ValidationError("task_id can only be updated on discovered sessions");
  }
  if (body.task_id && !(await db.query.tasks.findFirst({ where: eq(tasks.id, body.task_id) }))) {
    throw new NotFoundError("Task", body.task_id);
  }

  let updatedThread: ChatThread | null = thread;
  if (thread && (nextTitle !== undefined || body.hidden !== undefined || hasChatConfigPatch)) {
    const updater = chatControl().updateThread;
    if (!updater) {
      throw new ValidationError("Chat session updates are unavailable");
    }
    updatedThread = updater(thread.id, body) ?? thread;
  }

  if (row) {
    const patch: Partial<typeof gateway_sessions.$inferInsert> = {};
    if (body.task_id !== undefined) patch.task_id = body.task_id;
    if (nextTitle !== undefined) patch.display_title = nextTitle;
    if (body.hidden !== undefined)
      patch.hidden_at = body.hidden ? (row.hidden_at ?? new Date()) : null;
    if (Object.keys(patch).length > 0) {
      await db
        .update(gateway_sessions)
        .set({ ...patch, updated_at: new Date() })
        .where(eq(gateway_sessions.id, row.id));
    }
    const [dto] = await toLiveDtos([
      {
        ...row,
        ...(body.task_id !== undefined ? { task_id: body.task_id } : {}),
        ...(nextTitle !== undefined ? { display_title: nextTitle } : {}),
        ...(body.hidden !== undefined ? { hidden_at: patch.hidden_at ?? null } : {}),
      },
    ]);
    if (dto) {
      if (updatedThread) {
        if (body.model !== undefined) dto.model = updatedThread.config.model || null;
        if (body.permission_mode !== undefined) {
          dto.permission_mode = updatedThread.config.permissionMode ?? null;
        }
      }
      return c.json(dto, 200);
    }
  }
  if (!updatedThread) throw new NotFoundError("Session", id);
  return c.json(threadToLiveDto(updatedThread), 200);
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

app.openapi(createSessionRoute, async (c) => {
  const db = getDb();
  const body = c.req.valid("json");
  let projectId: string | null = null;
  const projectRef = body.project_id ?? body.project;
  if (projectRef) {
    const project = await db.query.projects.findFirst({
      where: or(eq(projects.id, projectRef), eq(projects.name, projectRef)),
      columns: { id: true },
    });
    if (!project) throw new NotFoundError("Project", projectRef);
    projectId = project.id;
  }
  const id = ulid();
  const createdAt = new Date();
  await db.insert(sessions).values({
    id,
    agent: body.agent,
    agent_version: body.agent_version,
    project_id: projectId,
    summary: body.summary,
    tokens_used: body.tokens_used,
    created_at: createdAt,
  });
  const created = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
  if (!created) throw new NotFoundError("Session", id);
  return c.json(toDto(created), 201);
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
