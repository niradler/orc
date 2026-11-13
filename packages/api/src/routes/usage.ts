import { createRoute, z } from "@hono/zod-openapi";
import { CLAUDE_TOKENS_VERSION, UsageHistorySchema, UsageQuotasSchema } from "@orc/core/usage";
import { getSqlite } from "@orc/db/client";
import { createRouter } from "../lib/router.js";
import { LIVE_CHAT_ID } from "../sessions/common.js";
import { readUsageQuotas } from "../usage-quotas.js";

const app = createRouter();

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
    path: "/usage/quotas",
    tags: ["Usage"],
    summary:
      "Read local Codex, Claude and Alibaba Cloud account quota windows (cached for 60 seconds)",
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
