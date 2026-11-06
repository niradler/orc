import { afterAll, beforeAll, expect, test } from "bun:test";
import { OrcError } from "@orc/core/errors";
import { UsageHistorySchema } from "@orc/core/usage";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { Hono } from "hono";
import { bearerAuth } from "../middleware/auth";
import { usageRouter } from "../routes/usage";
import { LIVE_CHAT_ID } from "../session-watcher";
import { createQuotaReader, decodeClaudeQuota, decodeCodexQuota } from "../usage-quotas";

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
  for (const route of ["history", "quotas"])
    expect((await app.request(`/api/usage/${route}`)).status).toBe(401);
  for (const days of ["-1", "1", "365", "7 OR 1=1"])
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
