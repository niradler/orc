import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCacheUsageSchema } from "@orc/core/usage";
import { getSqlite } from "@orc/db/client";
import { loadSessionCacheUsage, readSessionCacheUsage } from "../sessions/cache-usage";
import { LIVE_CHAT_ID } from "../sessions/common";
import { req, setupTestApp, teardownTestApp } from "./helpers";

const bytes = (rows: unknown[]) =>
  new TextEncoder().encode(rows.map((row) => JSON.stringify(row)).join("\n"));
const claude = (id: string, cached: number, writes: number, lifetime = false) => ({
  type: "assistant",
  timestamp: "2026-11-06T12:00:00Z",
  message: {
    id,
    model: "claude",
    content: "private-prompt-do-not-leak",
    usage: {
      input_tokens: 10,
      output_tokens: 999,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: writes,
      ...(lifetime ? { cache_creation: { ephemeral_5m_input_tokens: writes } } : {}),
    },
  },
});

test("should deduplicate Claude input, include cache writes in the denominator, and use reported lifetime only", () => {
  const first = claude("first", 70, 20, true);
  const result = readSessionCacheUsage("claude", bytes([first, first]));
  expect(result.latest).toEqual({
    input_tokens: 100,
    cached_input_tokens: 70,
    cache_write_tokens: 20,
    recorded_at: "2026-11-06T12:00:00.000Z",
    may_be_cold_after: "2026-11-06T12:05:00.000Z",
  });
  expect(result.totals?.input_tokens).toBe(100);
  expect(
    readSessionCacheUsage("claude", bytes([claude("no-ttl", 70, 20)])).latest?.may_be_cold_after,
  ).toBeNull();
  const later = { ...claude("later", 0, 0), timestamp: "2026-11-06T12:01:00Z" };
  expect(readSessionCacheUsage("claude", bytes([first, later])).latest).toMatchObject({
    cached_input_tokens: 0,
    may_be_cold_after: null,
  });
});

test("should use Codex reported cumulative counters without adding duplicate snapshots or counting cached input twice", () => {
  const row = {
    type: "event_msg",
    timestamp: "2026-11-06T12:00:00Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 80,
          cache_write_input_tokens: 10,
        },
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 700,
          cache_write_input_tokens: 100,
        },
      },
    },
  };
  const result = readSessionCacheUsage("codex", bytes([row, row]));
  expect(result.latest).toMatchObject({
    input_tokens: 100,
    cached_input_tokens: 80,
    may_be_cold_after: null,
  });
  expect(result.totals).toEqual({
    input_tokens: 1000,
    cached_input_tokens: 700,
    cache_write_tokens: 100,
  });
  const invalid = {
    ...row,
    payload: {
      ...row.payload,
      info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 99 } },
    },
  };
  expect(readSessionCacheUsage("codex", bytes([invalid])).latest).toBeNull();
});

test("should hide unsupported, malformed or unreported cache evidence rather than invent zeroes or expiry", () => {
  for (const provider of ["cursor", "cursor-agent", "gemini", "opencode"])
    expect(readSessionCacheUsage(provider, bytes([claude("one", 80, 10)]))).toEqual({
      latest: null,
      totals: null,
    });
  expect(
    readSessionCacheUsage("claude", new TextEncoder().encode("invalid-json\n{}")).latest,
  ).toBeNull();
  expect(
    readSessionCacheUsage(
      "claude",
      bytes([{ type: "assistant", message: { usage: { input_tokens: 10 } } }]),
    ).latest,
  ).toBeNull();
  const missingTime = claude("missing-time", 70, 20, true);
  expect(
    readSessionCacheUsage("claude", bytes([{ ...missingTime, timestamp: undefined }])).latest
      ?.may_be_cold_after,
  ).toBeNull();
});

test("should keep private source errors out of cache endpoint failures", async () => {
  await expect(
    loadSessionCacheUsage(
      {
        isFile: async () => true,
        readFile: async () => {
          throw new Error("private-server-path-and-prompt");
        },
      },
      "claude",
      "private-server-path",
    ),
  ).rejects.toMatchObject({
    message: "Session cache usage could not be read",
    code: "CACHE_UNAVAILABLE",
    statusCode: 503,
  });
});

let app: ReturnType<typeof setupTestApp>;
const root = mkdtempSync(join(tmpdir(), "orc-session-cache-"));
beforeAll(() => {
  app = setupTestApp();
});
afterAll(async () => {
  teardownTestApp();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("should serve authenticated numeric cache data for the stored session path only", async () => {
  const path = join(root, "session.jsonl");
  writeFileSync(path, new TextDecoder().decode(bytes([claude("api", 70, 20, true)])));
  const sqlite = getSqlite();
  sqlite.run(
    "INSERT OR IGNORE INTO bridge_chats (id, platform, chat_id) VALUES (?, 'telegram', ?)",
    [LIVE_CHAT_ID, LIVE_CHAT_ID],
  );
  sqlite.run(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, transcript_path) VALUES ('cache-api', ?, 'claude', 'direct', ?)",
    [LIVE_CHAT_ID, path],
  );
  expect((await app.request("/api/sessions/live/cache-api/cache")).status).toBe(401);
  expect((await req(app, "GET", "/sessions/live/not-a-session/cache")).status).toBe(404);
  const response = await req(app, "GET", "/sessions/live/cache-api/cache?path=must-not-use-this");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const result = SessionCacheUsageSchema.parse(await response.json());
  expect(result.latest?.cached_input_tokens).toBe(70);
  expect(JSON.stringify(result)).not.toContain("private-prompt");
  expect(JSON.stringify(result)).not.toContain(path);
  sqlite.run(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode) VALUES ('cache-missing', ?, 'codex', 'direct')",
    [LIVE_CHAT_ID],
  );
  expect(await (await req(app, "GET", "/sessions/live/cache-missing/cache")).json()).toEqual({
    latest: null,
    totals: null,
  });
});
