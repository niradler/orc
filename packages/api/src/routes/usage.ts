import { createRoute, z } from "@hono/zod-openapi";
import {
  CLAUDE_TOKENS_VERSION,
  UsageHistorySchema,
  UsageQuotasSchema,
  UsageReportSchema,
} from "@orc/core/usage";
import { getSqlite } from "@orc/db/client";
import { createRouter } from "../lib/router.js";
import { LIVE_CHAT_ID } from "../sessions/common.js";
import { readUsageQuotas } from "../usage-quotas.js";

const app = createRouter();

type UsageNumberRow = {
  agent?: string;
  model?: string | null;
  bucket?: string;
  requests: number;
  sessions: number;
  estimated_requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  other_tokens: number;
  total_tokens: number;
};

const NUMBER_COLUMNS = `
  coalesce(sum(requests), 0) AS requests,
  count(DISTINCT session_id) AS sessions,
  coalesce(sum(estimated_requests), 0) AS estimated_requests,
  coalesce(sum(input_tokens), 0) AS input_tokens,
  coalesce(sum(output_tokens), 0) AS output_tokens,
  coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens,
  coalesce(sum(cache_write_tokens), 0) AS cache_write_tokens,
  coalesce(sum(reasoning_tokens), 0) AS reasoning_tokens,
  coalesce(sum(other_tokens), 0) AS other_tokens,
  coalesce(sum(total_tokens), 0) AS total_tokens
`;

function usageRows(
  select: string,
  where: string,
  binds: (string | number)[],
  groupBy: string,
  order: string,
): UsageNumberRow[] {
  return getSqlite()
    .query<UsageNumberRow, (string | number)[]>(
      `SELECT ${select} ${NUMBER_COLUMNS} FROM usage_events ${where}${
        groupBy ? ` GROUP BY ${groupBy}` : ""
      }${order ? ` ORDER BY ${order}` : ""}`,
    )
    .all(...binds);
}

app.openapi(
  createRoute({
    method: "get",
    path: "/usage/history",
    tags: ["Usage"],
    summary: "Lifetime token totals for imported sessions started in a selected period",
    request: { query: z.object({ days: z.enum(["7", "30", "90", "0"]).default("30") }) },
    responses: {
      200: {
        description: "Session usage grouped by agent and UTC start date",
        content: { "application/json": { schema: UsageHistorySchema } },
      },
    },
  }),
  (c) => {
    const days = Number(c.req.valid("query").days);
    const since = days ? new Date(Date.now() - days * 86_400_000) : null;
    const rows = getSqlite()
      .query<
        {
          agent: string;
          date: string;
          sessions: number;
          tokens: number;
          unknown_sessions: number;
          estimated_sessions: number;
        },
        [number, string, number]
      >(`
    WITH imported AS (
      SELECT backend, created_at,
        CASE WHEN backend = 'claude' AND tokens_version < ? THEN NULL ELSE tokens_used END AS tokens_used
      FROM gateway_sessions WHERE chat_id = ? AND created_at >= ?
    )
    SELECT backend AS agent, date(created_at, 'unixepoch') AS date,
      count(*) AS sessions, coalesce(sum(max(coalesce(tokens_used, 0), 0)), 0) AS tokens,
      sum(CASE WHEN tokens_used IS NULL THEN 1 ELSE 0 END) AS unknown_sessions,
      sum(CASE WHEN backend = 'cursor' AND tokens_used IS NOT NULL THEN 1 ELSE 0 END) AS estimated_sessions
    FROM imported
    GROUP BY backend, date(created_at, 'unixepoch') ORDER BY date DESC, backend
  `)
      .all(CLAUDE_TOKENS_VERSION, LIVE_CHAT_ID, since ? Math.floor(since.getTime() / 1000) : 0);
    const totals = { sessions: 0, tokens: 0, unknown_sessions: 0, estimated_sessions: 0 };
    const agents = new Map<string, typeof totals & { agent: string }>();
    const daily = new Map<string, typeof totals & { date: string }>();
    for (const row of rows) {
      const agent = agents.get(row.agent) ?? {
        sessions: 0,
        tokens: 0,
        unknown_sessions: 0,
        estimated_sessions: 0,
        agent: row.agent,
      };
      const day = daily.get(row.date) ?? {
        sessions: 0,
        tokens: 0,
        unknown_sessions: 0,
        estimated_sessions: 0,
        date: row.date,
      };
      for (const key of ["sessions", "tokens", "unknown_sessions", "estimated_sessions"] as const) {
        totals[key] += row[key];
        agent[key] += row[key];
        day[key] += row[key];
      }
      agents.set(row.agent, agent);
      daily.set(row.date, day);
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      days,
      since: since?.toISOString() ?? null,
      totals,
      agents: [...agents.values()].sort(
        (a, b) => b.tokens - a.tokens || a.agent.localeCompare(b.agent),
      ),
      daily: [...daily.values()],
    });
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/usage/report",
    tags: ["Usage"],
    summary: "Per-request token usage with model distributions and time buckets",
    request: {
      query: z.object({
        days: z.enum(["1", "7", "30", "90", "0"]).default("30"),
        granularity: z.enum(["day", "hour"]).default("day"),
        agent: z.string().max(64).optional(),
        model: z.string().max(200).optional(),
      }),
    },
    responses: {
      200: {
        description: "Totals, agent and model distributions, and time buckets for the period",
        content: { "application/json": { schema: UsageReportSchema } },
      },
    },
  }),
  (c) => {
    const query = c.req.valid("query");
    const days = Number(query.days);
    const since = days ? new Date(Date.now() - days * 86_400_000) : null;
    const sinceMs = since?.getTime() ?? null;
    const sinceSeconds = since ? Math.floor(since.getTime() / 1000) : null;
    const agent = query.agent?.trim() || null;
    const model = query.model?.trim() || null;
    const granularity = query.granularity;

    const where = (extra: string[] = [], binds: (string | number)[] = []) => {
      const clauses = [...(sinceMs === null ? [] : ["ts >= ?"]), ...extra];
      const values = [...(sinceMs === null ? [] : [sinceMs]), ...binds];
      return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", binds: values };
    };
    const agentFilter = agent ? { sql: "agent = ?", bind: agent } : null;
    const modelFilter =
      model === "__unknown__"
        ? { sql: "model IS NULL", bind: null }
        : model
          ? { sql: "model = ?", bind: model }
          : null;

    const totalsWhere = where(
      [...(agentFilter ? [agentFilter.sql] : []), ...(modelFilter ? [modelFilter.sql] : [])],
      [
        ...(agentFilter ? [agentFilter.bind as string] : []),
        ...(modelFilter?.bind ? [modelFilter.bind] : []),
      ],
    );
    const totals = usageRows("", totalsWhere.sql, totalsWhere.binds, "", "")[0];

    const agentWhere = where(
      modelFilter ? [modelFilter.sql] : [],
      modelFilter?.bind ? [modelFilter.bind] : [],
    );
    const agents = usageRows(
      "agent,",
      agentWhere.sql,
      agentWhere.binds,
      "agent",
      "total_tokens DESC, agent",
    );

    const modelWhere = where(
      agentFilter ? [agentFilter.sql] : [],
      agentFilter ? [agentFilter.bind as string] : [],
    );
    const models = usageRows(
      "agent, model,",
      modelWhere.sql,
      modelWhere.binds,
      "agent, model",
      "total_tokens DESC, agent, model",
    );

    const bucket =
      granularity === "hour"
        ? "strftime('%Y-%m-%dT%H:00Z', ts / 1000, 'unixepoch')"
        : "strftime('%Y-%m-%d', ts / 1000, 'unixepoch')";
    const buckets = usageRows(
      `${bucket} AS bucket,`,
      totalsWhere.sql,
      totalsWhere.binds,
      "bucket",
      "bucket",
    );

    const coverage = getSqlite()
      .query<
        {
          unindexed_sessions: number;
          unknown_sessions: number;
          unindexed_tokens: number;
          estimated_sessions: number;
        },
        (string | number | null)[]
      >(
        `SELECT count(*) AS unindexed_sessions,
           coalesce(sum(CASE WHEN gs.tokens_used IS NULL THEN 1 ELSE 0 END), 0) AS unknown_sessions,
           coalesce(sum(coalesce(gs.tokens_used, 0)), 0) AS unindexed_tokens,
           coalesce(sum(CASE WHEN gs.backend = 'cursor' AND gs.tokens_used IS NOT NULL THEN 1 ELSE 0 END), 0) AS estimated_sessions
         FROM gateway_sessions gs
         WHERE gs.chat_id = ?
           AND (? IS NULL OR gs.created_at >= ?)
           AND NOT EXISTS (
             SELECT 1 FROM usage_events e
             WHERE e.session_id = gs.id AND (? IS NULL OR e.ts >= ?)
           )`,
      )
      .get(LIVE_CHAT_ID, sinceSeconds, sinceSeconds, sinceMs, sinceMs);
    const indexed = getSqlite()
      .query<{ sessions: number }, (number | null)[]>(
        "SELECT count(DISTINCT session_id) AS sessions FROM usage_events WHERE (? IS NULL OR ts >= ?)",
      )
      .get(sinceMs, sinceMs);

    const empty = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      other_tokens: 0,
      total_tokens: 0,
      requests: 0,
      sessions: 0,
      estimated_requests: 0,
    };
    c.header("Cache-Control", "no-store");
    return c.json({
      days,
      since: since?.toISOString() ?? null,
      granularity,
      filters: { agent, model },
      totals: totals ?? empty,
      agents: agents.map((row) => ({ ...row, agent: row.agent ?? "unknown" })),
      models: models.map((row) => ({
        ...row,
        agent: row.agent ?? "unknown",
        model: row.model ?? null,
      })),
      buckets: buckets.map((row) => ({ ...row, bucket: row.bucket ?? "" })),
      coverage: {
        indexed_sessions: indexed?.sessions ?? 0,
        unindexed_sessions: coverage?.unindexed_sessions ?? 0,
        unindexed_tokens: coverage?.unindexed_tokens ?? 0,
        unknown_sessions: coverage?.unknown_sessions ?? 0,
        estimated_sessions: coverage?.estimated_sessions ?? 0,
      },
    });
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/usage/quotas",
    tags: ["Usage"],
    summary: "Read local Codex and Claude account quota windows (cached for 60 seconds)",
    responses: {
      200: {
        description: "Per-provider quota availability and reset times; no credentials",
        content: { "application/json": { schema: UsageQuotasSchema } },
      },
    },
  }),
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ accounts: await readUsageQuotas() });
  },
);

export { app as usageRouter };
