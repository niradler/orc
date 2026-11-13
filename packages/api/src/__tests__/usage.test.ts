import { afterAll, beforeAll, expect, test } from "bun:test";
import { changes } from "@orc/core/changes";
import { OrcError } from "@orc/core/errors";
import {
  USAGE_EVENT_VERSION,
  USAGE_RAW_RETENTION_DAYS,
  UsageHistorySchema,
  UsageReportSchema,
} from "@orc/core/usage";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { Hono } from "hono";
import { bearerAuth } from "../middleware/auth";
import { usageRouter } from "../routes/usage";
import { LIVE_CHAT_ID, runSync } from "../session-watcher";
import type { SessionAdapter } from "../sessions/types";
import { maintainUsageRetention, writeSessionUsage } from "../sessions/usage-events";
import {
  createQuotaReader,
  createTargetQuotaReader,
  decodeClaudeQuota,
  decodeCodexQuota,
} from "../usage-quotas";

const app = new Hono();
app.onError((error, c) =>
  c.json({ error: "Request failed" }, error instanceof OrcError ? (error.statusCode as 401) : 500),
);
app.use("/api/*", bearerAuth("usage-test"));
app.route("/api", usageRouter);
const headers = { Authorization: "Bearer usage-test" };
beforeAll(() => {
  createTestDb();
});
afterAll(() => {
  closeDb();
});

test("should protect both usage endpoints and reject invalid periods", async () => {
  for (const route of ["history", "quotas", "report"])
    expect((await app.request(`/api/usage/${route}`)).status).toBe(401);
  for (const days of ["-1", "365", "7 OR 1=1"])
    expect(
      (await app.request(`/api/usage/history?days=${encodeURIComponent(days)}`, { headers }))
        .status,
    ).toBe(400);
});

test("should aggregate imported sessions once, preserve unknown and estimated counts, and filter by start date", async () => {
  const db = getSqlite();
  db.run("INSERT OR IGNORE INTO bridge_chats (id, platform, chat_id) VALUES (?, 'telegram', ?)", [
    LIVE_CHAT_ID,
    "Imported",
  ]);
  const now = Math.floor(Date.now() / 1000);
  const insert = db.query(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, tokens_used, created_at) VALUES (?, ?, ?, 'direct', ?, ?)",
  );
  insert.run("usage1", LIVE_CHAT_ID, "codex", 100, now);
  insert.run("usage2", LIVE_CHAT_ID, "claude", null, now);
  insert.run("usage3", LIVE_CHAT_ID, "cursor", 40, now);
  insert.run("usage4", LIVE_CHAT_ID, "codex", 50, now - 100 * 86400);
  db.run(
    "INSERT INTO bridge_chats (id, platform, chat_id) VALUES ('usage-managed', 'telegram', 'usage-managed')",
  );
  insert.run("usage5", "usage-managed", "codex", 999, now);
  const response = await app.request("/api/usage/history?days=7", { headers });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const data = UsageHistorySchema.parse(await response.json());
  expect(data.totals).toEqual({
    sessions: 3,
    tokens: 140,
    unknown_sessions: 1,
    estimated_sessions: 1,
  });
  expect(data.agents.map((a: { agent: string }) => a.agent)).toEqual(["codex", "cursor", "claude"]);
  expect(data.daily[0]?.tokens).toBe(140);
  const all = UsageHistorySchema.parse(
    await (await app.request("/api/usage/history?days=0", { headers })).json(),
  );
  expect(all.since).toBeNull();
  expect(all.totals.tokens).toBe(190);
  expect(all.daily).toHaveLength(2);
});

test("should exclude old Claude counts until they have been refreshed with cache-read tokens", async () => {
  const sqlite = getSqlite();
  const baseline = UsageHistorySchema.parse(
    await (await app.request("/api/usage/history?days=0", { headers })).json(),
  );
  sqlite.run(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, tokens_used, tokens_version, created_at) VALUES ('usage-old-claude', ?, 'claude', 'direct', 100, 0, ?)",
    [LIVE_CHAT_ID, Math.floor(Date.now() / 1000)],
  );
  const stale = UsageHistorySchema.parse(
    await (await app.request("/api/usage/history?days=0", { headers })).json(),
  );
  expect(stale.totals.tokens).toBe(baseline.totals.tokens);
  expect(stale.totals.unknown_sessions).toBe(baseline.totals.unknown_sessions + 1);
  sqlite.run(
    "UPDATE gateway_sessions SET tokens_used = 1500, tokens_version = 1 WHERE id = 'usage-old-claude'",
  );
  const refreshed = UsageHistorySchema.parse(
    await (await app.request("/api/usage/history?days=0", { headers })).json(),
  );
  expect(refreshed.totals.tokens).toBe(baseline.totals.tokens + 1500);
  expect(refreshed.totals.unknown_sessions).toBe(baseline.totals.unknown_sessions);
});

test("should report request totals, model facets and time buckets with filters", async () => {
  const sqlite = getSqlite();
  const now = Date.now();
  sqlite.run(
    "INSERT OR IGNORE INTO bridge_chats (id, platform, chat_id) VALUES (?, 'telegram', ?)",
    [LIVE_CHAT_ID, "Imported"],
  );
  const insertSession = sqlite.query(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, tokens_used, created_at) VALUES (?, ?, ?, 'direct', ?, ?)",
  );
  insertSession.run("report1", LIVE_CHAT_ID, "codex", 190, Math.floor(now / 1000));
  insertSession.run("report2", LIVE_CHAT_ID, "codex", null, Math.floor(now / 1000));
  insertSession.run("report3", LIVE_CHAT_ID, "gemini", 30, Math.floor(now / 1000));
  const insertEvent = sqlite.query(
    `INSERT INTO usage_events
       (id, session_id, event_key, agent, model, ts, input_tokens, output_tokens,
        cache_read_tokens, other_tokens, total_tokens, estimated_requests, estimated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertEvent.run("event1", "report1", "one", "codex", "model-a", now, 100, 50, 25, 0, 175, 0, 0);
  insertEvent.run(
    "event2",
    "report1",
    "two",
    "codex",
    "model-b",
    now - 3_600_000,
    10,
    0,
    0,
    5,
    15,
    0,
    0,
  );
  insertEvent.run("event3", "report3", "one", "gemini", null, now, 0, 0, 0, 30, 30, 1, 1);

  const response = await app.request(
    "/api/usage/report?days=7&granularity=hour&agent=codex&model=model-a",
    { headers },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const data = UsageReportSchema.parse(await response.json());
  expect(data.filters).toEqual({ agent: "codex", model: "model-a" });
  expect(data.totals).toEqual({
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 25,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    other_tokens: 0,
    total_tokens: 175,
    requests: 1,
    sessions: 1,
    estimated_requests: 0,
  });
  expect(data.buckets).toHaveLength(1);
  expect(data.buckets[0]?.bucket.endsWith(":00Z")).toBe(true);
  expect(data.agents.map((row) => row.agent)).toEqual(["codex"]);
  expect(data.models.map((row) => row.model).sort()).toEqual(["model-a", "model-b"]);
  expect(data.coverage.unindexed_sessions).toBeGreaterThanOrEqual(1);
  expect(data.coverage.unknown_sessions).toBeGreaterThanOrEqual(1);

  const unknown = UsageReportSchema.parse(
    await (
      await app.request("/api/usage/report?days=7&agent=gemini&model=__unknown__", { headers })
    ).json(),
  );
  expect(unknown.totals.total_tokens).toBe(30);
  expect(unknown.totals.estimated_requests).toBe(1);
  expect(unknown.models[0]?.model).toBeNull();

  const all = UsageReportSchema.parse(
    await (await app.request("/api/usage/report?days=0", { headers })).json(),
  );
  expect(all.since).toBeNull();
  expect(all.totals.total_tokens).toBe(220);
  expect((await app.request("/api/usage/report?days=2", { headers })).status).toBe(400);
});

test("should replace a session ledger idempotently and record its latest model", () => {
  const sqlite = getSqlite();
  sqlite.run(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, created_at) VALUES ('ledger1', ?, 'pi', 'direct', ?)",
    [LIVE_CHAT_ID, Math.floor(Date.now() / 1000)],
  );
  const event = (key: string, inputTokens: number) => ({
    key,
    ts: Date.now(),
    model: "deepseek-v4",
    inputTokens,
    outputTokens: 1,
    cacheReadTokens: 2,
    cacheWriteTokens: 3,
    reasoningTokens: 4,
    otherTokens: 0,
    estimated: false,
  });
  expect(
    writeSessionUsage(
      "ledger1",
      "pi",
      { events: [event("one", 10), event("two", 20)], tokens: 80, model: "deepseek-v4" },
      USAGE_EVENT_VERSION,
    ),
  ).toBe(2);
  expect(
    sqlite
      .query<{ requests: number; total: number }, []>(
        "SELECT count(*) AS requests, sum(total_tokens) AS total FROM usage_events WHERE session_id = 'ledger1'",
      )
      .get(),
  ).toEqual({ requests: 2, total: 50 });
  const row = sqlite
    .query<{ model: string; usage_version: number }, []>(
      "SELECT model, usage_version FROM gateway_sessions WHERE id = 'ledger1'",
    )
    .get();
  expect(row?.model).toBe("deepseek-v4");
  expect(row?.usage_version).toBe(USAGE_EVENT_VERSION);

  writeSessionUsage(
    "ledger1",
    "pi",
    { events: [event("one", 50)], tokens: 60, model: "deepseek-v5" },
    USAGE_EVENT_VERSION,
  );
  expect(
    sqlite
      .query<{ requests: number; total: number }, []>(
        "SELECT count(*) AS requests, sum(total_tokens) AS total FROM usage_events WHERE session_id = 'ledger1'",
      )
      .get(),
  ).toEqual({ requests: 1, total: 60 });
  expect(
    sqlite
      .query<{ model: string }, []>("SELECT model FROM gateway_sessions WHERE id = 'ledger1'")
      .get()?.model,
  ).toBe("deepseek-v5");
});

test("should keep 95 days of raw requests and roll older usage up by day and model", async () => {
  const sqlite = getSqlite();
  const now = Date.now();
  const day = 86_400_000;
  sqlite.run(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, created_at) VALUES ('retention1', ?, 'codex', 'direct', ?)",
    [LIVE_CHAT_ID, Math.floor(now / 1000)],
  );
  const request = (input: number, ts: number) => ({
    key: `request-${ts}`,
    ts,
    model: "gpt-6",
    inputTokens: input,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    otherTokens: 0,
    estimated: false,
  });
  const oldTs = now - (USAGE_RAW_RETENTION_DAYS + 5) * day;
  const usage = { tokens: 30, model: "gpt-6", events: [request(10, oldTs), request(20, now)] };
  expect(writeSessionUsage("retention1", "codex", usage, USAGE_EVENT_VERSION, now)).toBe(2);

  const rows = sqlite
    .query<{ ts: number; requests: number; resolution: string }, []>(
      "SELECT ts, requests, resolution FROM usage_events WHERE session_id = 'retention1' ORDER BY ts",
    )
    .all();
  expect(rows).toHaveLength(2);
  expect(rows[0]?.resolution).toBe("rollup");
  expect(rows[0]?.requests).toBe(1);
  expect(rows[0]?.ts).toBe(Date.parse(`${new Date(oldTs).toISOString().slice(0, 10)}T00:00:00Z`));
  expect(rows[1]?.resolution).toBe("request");

  // Re-indexing the same transcript replaces the rollup instead of duplicating it.
  writeSessionUsage("retention1", "codex", usage, USAGE_EVENT_VERSION, now);
  expect(
    sqlite
      .query<{ rows: number; requests: number }, []>(
        "SELECT count(*) AS rows, sum(requests) AS requests FROM usage_events WHERE session_id = 'retention1'",
      )
      .get(),
  ).toEqual({ rows: 2, requests: 2 });

  const report = UsageReportSchema.parse(
    await (await app.request("/api/usage/report?days=0&model=gpt-6", { headers })).json(),
  );
  expect(report.totals).toMatchObject({ requests: 2, sessions: 1, total_tokens: 30 });
  expect(report.buckets).toHaveLength(2);
});

test("should roll aged raw rows up without changing totals", () => {
  const sqlite = getSqlite();
  const now = Date.now();
  const oldTs = now - (USAGE_RAW_RETENTION_DAYS + 10) * 86_400_000;
  sqlite.run(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, created_at) VALUES ('retention2', ?, 'pi', 'direct', ?)",
    [LIVE_CHAT_ID, Math.floor(now / 1000)],
  );
  sqlite.run(
    `INSERT INTO usage_events
       (id, session_id, event_key, agent, model, ts, input_tokens, total_tokens, requests)
     VALUES ('aged1', 'retention2', 'aged', 'pi', 'deepseek-v4', ?, 7, 7, 1)`,
    [oldTs],
  );

  expect(maintainUsageRetention(now)).toBe(1);
  expect(
    sqlite
      .query<{ ts: number; requests: number; total: number; resolution: string }, []>(
        "SELECT ts, requests, total_tokens AS total, resolution FROM usage_events WHERE session_id = 'retention2'",
      )
      .get(),
  ).toEqual({
    ts: Date.parse(`${new Date(oldTs).toISOString().slice(0, 10)}T00:00:00Z`),
    requests: 1,
    total: 7,
    resolution: "rollup",
  });
  expect(maintainUsageRetention(now)).toBe(0);
});

test("should keep estimated request counts when old usage rolls up", async () => {
  const sqlite = getSqlite();
  const now = Date.now();
  const oldTs = now - (USAGE_RAW_RETENTION_DAYS + 3) * 86_400_000;
  sqlite.run(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, created_at) VALUES ('retention3', ?, 'gemini', 'direct', ?)",
    [LIVE_CHAT_ID, Math.floor(now / 1000)],
  );
  // Insert raw aged rows so the retention sweep (not the write path) rolls them up.
  const insertEvent = sqlite.query(
    `INSERT INTO usage_events
       (id, session_id, event_key, agent, model, ts, other_tokens, total_tokens,
        requests, estimated_requests, resolution, estimated)
     VALUES (?, 'retention3', ?, 'gemini', NULL, ?, ?, ?, 1, 1, 'request', 1)`,
  );
  insertEvent.run("ret3-old", "gemini-0", oldTs, 40, 40);
  insertEvent.run("ret3-new", "gemini-1", now, 5, 5);
  expect(maintainUsageRetention(now)).toBeGreaterThanOrEqual(1);
  expect(
    sqlite
      .query<
        { estimated_requests: number; estimated: number; requests: number; total: number },
        []
      >(
        `SELECT estimated_requests, estimated, requests, total_tokens AS total
         FROM usage_events WHERE session_id = 'retention3' AND resolution = 'rollup'`,
      )
      .get(),
  ).toEqual({ estimated_requests: 1, estimated: 1, requests: 1, total: 40 });
  const report = UsageReportSchema.parse(
    await (
      await app.request("/api/usage/report?days=0&agent=gemini&model=__unknown__", { headers })
    ).json(),
  );
  expect(report.totals).toMatchObject({
    total_tokens: 75,
    requests: 3,
    estimated_requests: 3,
    sessions: 2,
  });
});

test("should cap a chatty session while keeping represented requests and totals", () => {
  const sqlite = getSqlite();
  const now = Date.now();
  sqlite.run(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, created_at) VALUES ('compact1', ?, 'codex', 'direct', ?)",
    [LIVE_CHAT_ID, Math.floor(now / 1000)],
  );
  const events = Array.from({ length: 5_010 }, (_, index) => ({
    key: `request-${index}`,
    ts: now - (5_010 - index) * 15 * 60_000,
    model: "gpt-6",
    inputTokens: 1,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    otherTokens: 0,
    estimated: false,
  }));
  expect(
    writeSessionUsage(
      "compact1",
      "codex",
      { events, tokens: 5_010, model: "gpt-6" },
      USAGE_EVENT_VERSION,
      now,
    ),
  ).toBeLessThanOrEqual(5_000);
  expect(
    sqlite
      .query<{ requests: number; total: number; rollups: number }, []>(
        `SELECT sum(requests) AS requests, sum(total_tokens) AS total,
                sum(CASE WHEN resolution = 'rollup' THEN 1 ELSE 0 END) AS rollups
         FROM usage_events WHERE session_id = 'compact1'`,
      )
      .get(),
  ).toEqual({ requests: 5_010, total: 5_010, rollups: 1 });
});

test("should decode quota windows including zero and exhausted usage and reject malformed data", () => {
  expect(
    decodeClaudeQuota({
      five_hour: { utilization: 20, resets_at: "2026-11-07T00:20:00.501236+00:00" },
    })[0]?.resets_at,
  ).toBe("2026-11-07T00:20:00.501Z");
  expect(
    decodeCodexQuota({
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1800000000 },
        secondary_window: { used_percent: 100 },
      },
    }),
  ).toEqual([
    { label: "5-hour window", used_percent: 0, resets_at: new Date(1800000000000).toISOString() },
    { label: "Secondary window", used_percent: 100, resets_at: null },
  ]);
  expect(
    decodeClaudeQuota({ five_hour: { utilization: 42, resets_at: null }, seven_day: null }),
  ).toEqual([{ label: "5-hour window", used_percent: 42, resets_at: null }]);
  expect(() => decodeClaudeQuota({ five_hour: { utilization: -1 } })).toThrow();
  expect(() =>
    decodeCodexQuota({ rate_limit: { primary_window: { used_percent: 101 } } }),
  ).toThrow();
});

test("should cache concurrent reads, use only fixed HTTPS endpoints, and never return credentials or provider errors", async () => {
  const urls: string[] = [];
  const reader = createQuotaReader({
    home: "fixture",
    read: async (path) =>
      path.endsWith("auth.json")
        ? JSON.stringify({
            tokens: { access_token: "private-codex", account_id: "private-account" },
          })
        : JSON.stringify({ claudeAiOauth: { accessToken: "private-claude" } }),
    fetch: async (url, options) => {
      urls.push(url);
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeDefined();
      if (url.includes("chatgpt.com"))
        return Response.json({
          rate_limit: { primary_window: { used_percent: 25 } },
          secret: "private-response",
        });
      return new Response("private-upstream-error", { status: 401 });
    },
  });
  const [first, second] = await Promise.all([reader(), reader()]);
  expect(first).toEqual(second);
  expect(await reader()).toEqual(first);
  expect(urls).toEqual([
    "https://chatgpt.com/backend-api/wham/usage",
    "https://api.anthropic.com/api/oauth/usage",
  ]);
  expect(first.map((account) => account.status)).toEqual(["available", "unavailable"]);
  expect(JSON.stringify(first)).not.toContain("private-");
});

test("should handle absent logins without network calls and isolate failed providers", async () => {
  const missing = createQuotaReader({
    home: "fixture",
    read: async () => {
      throw new Error("private path");
    },
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  expect((await missing()).map((a) => a.status)).toEqual(["signed_out", "signed_out"]);
  const failed = createQuotaReader({
    home: "fixture",
    read: async () =>
      JSON.stringify({
        tokens: { access_token: "private" },
        claudeAiOauth: { accessToken: "private" },
      }),
    fetch: async (url) => {
      if (url.includes("chatgpt")) throw new Error("private network detail");
      return Response.json({ seven_day: { utilization: 75 } });
    },
  });
  expect((await failed()).map((a) => a.status)).toEqual(["unavailable", "available"]);
});

test("should read each configured provider from its own directory", async () => {
  const paths: string[] = [];
  const reader = createTargetQuotaReader(
    {
      home: "fixture",
      read: async (path) => {
        paths.push(path);
        if (path.includes("signed-out")) throw new Error("private missing account");
        return JSON.stringify({ claudeAiOauth: { accessToken: "private-token" } });
      },
      fetch: async () =>
        Response.json({ five_hour: { utilization: 30 }, seven_day: { utilization: 60 } }),
    },
    () => [
      {
        provider: "claude",
        providerId: "claude-a",
        name: "Claude A",
        home: "/accounts/a",
      },
      {
        provider: "claude",
        providerId: "claude-b",
        name: "Claude B",
        home: "/accounts/signed-out",
      },
    ],
  );
  const quotas = await reader();
  expect(quotas.map((quota) => [quota.provider_id, quota.name, quota.status])).toEqual([
    ["claude-a", "Claude A", "available"],
    ["claude-b", "Claude B", "signed_out"],
  ]);
  expect(quotas[0]?.windows).toHaveLength(2);
  expect(quotas[1]?.windows).toHaveLength(0);
  expect(paths.some((path) => path.includes("signed-out"))).toBe(true);
  expect(JSON.stringify(quotas)).not.toContain("private-token");
});

test("should publish usage changes for new sessions and completed ledger writes", async () => {
  let events = 0;
  let wake: (() => void) | undefined;
  const indexed = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const unsubscribe = changes.subscribe(({ resources }) => {
    if (!resources.includes("usage")) return;
    events += 1;
    if (events >= 2) wake?.();
  });
  try {
    const adapter: SessionAdapter = {
      backend: "pi",
      minIntervalMs: 1,
      list: async () => [
        {
          backend: "pi",
          externalId: "watcher-usage",
          title: "watcher usage",
          status: "stopped",
          createdAt: new Date(),
          lastActivityAt: new Date(),
          usageVersion: USAGE_EVENT_VERSION,
          usage: async () => ({
            tokens: 7,
            model: "model-watcher",
            events: [
              {
                key: "request",
                ts: Date.now(),
                model: "model-watcher",
                inputTokens: 7,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
                otherTokens: 0,
                estimated: false,
              },
            ],
          }),
        },
      ],
    };
    await runSync([adapter], { force: true });
    await Promise.race([indexed, Bun.sleep(3000)]);
    expect(events).toBeGreaterThanOrEqual(2);
    expect(
      getSqlite()
        .query<{ requests: number }, []>(
          `SELECT count(*) AS requests FROM usage_events e
           JOIN gateway_sessions s ON s.id = e.session_id
           WHERE s.runtime_session_id = 'watcher-usage'`,
        )
        .get()?.requests,
    ).toBe(1);
  } finally {
    unsubscribe();
  }
});
