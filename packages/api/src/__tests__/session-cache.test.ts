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
    context_tokens: 100,
    context_window: null,
  });
  expect(result.totals?.input_tokens).toBe(100);
  expect(result.output_tokens).toBe(999);
  expect(result.requests).toBe(1);
  expect(result.compactions).toEqual([]);
  expect(
    readSessionCacheUsage("claude", bytes([claude("no-ttl", 70, 20)])).latest?.may_be_cold_after,
  ).toBeNull();
  const later = { ...claude("later", 0, 0), timestamp: "2026-11-06T12:01:00Z" };
  expect(readSessionCacheUsage("claude", bytes([first, later])).latest).toMatchObject({
    cached_input_tokens: 0,
    may_be_cold_after: null,
  });
});

test("should count Claude compactions with their recorded trigger and before and after context size", () => {
  const compact = (timestamp: string, compactMetadata: unknown) => ({
    type: "system",
    subtype: "compact_boundary",
    timestamp,
    compactMetadata,
  });
  const result = readSessionCacheUsage(
    "claude",
    bytes([
      claude("before", 70, 20),
      compact("2026-11-06T12:10:00Z", { trigger: "auto", preTokens: 448563, postTokens: 41112 }),
      claude("after", 40, 5),
      compact("2026-11-06T12:20:00Z", {
        trigger: "manual",
        preTokens: 41112,
        postTokens: 12000,
      }),
      compact("2026-11-06T12:30:00Z", { preTokens: "bad", trigger: "because-it-was-large" }),
    ]),
  );
  expect(result.compactions).toEqual([
    {
      recorded_at: "2026-11-06T12:10:00.000Z",
      pre_tokens: 448563,
      post_tokens: 41112,
      trigger: "auto",
    },
    {
      recorded_at: "2026-11-06T12:20:00.000Z",
      pre_tokens: 41112,
      post_tokens: 12000,
      trigger: "manual",
    },
    {
      recorded_at: "2026-11-06T12:30:00.000Z",
      pre_tokens: null,
      post_tokens: null,
      trigger: null,
    },
  ]);
  expect(result.requests).toBe(2);
  expect(result.output_tokens).toBe(1998);
  expect(result.timeline?.map((point) => point.context_tokens)).toEqual([100, 55]);
});

test("should count Codex compactions with the context before and after them", () => {
  const usage = (timestamp: string, input: number, total: number) => ({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: input, cached_input_tokens: 0 },
        total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 1 },
      },
    },
  });
  const result = readSessionCacheUsage(
    "codex",
    bytes([
      usage("2026-11-06T12:00:00Z", 180_000, 180_000),
      { type: "compacted", timestamp: "2026-11-06T12:05:00Z", payload: { message: "summary" } },
      {
        type: "event_msg",
        timestamp: "2026-11-06T12:05:00Z",
        payload: { type: "context_compacted" },
      },
      usage("2026-11-06T12:06:00Z", 22_000, 202_000),
      { type: "compacted", timestamp: "2026-11-06T12:30:00Z", payload: { message: "again" } },
      usage("2026-11-06T12:30:00Z", 0, 202_000),
    ]),
  );
  expect(result.latest?.input_tokens).toBe(22_000);
  expect(result.compactions).toEqual([
    {
      recorded_at: "2026-11-06T12:05:00.000Z",
      pre_tokens: 180_000,
      post_tokens: 22_000,
      trigger: null,
    },
    {
      recorded_at: "2026-11-06T12:30:00.000Z",
      pre_tokens: 22_000,
      post_tokens: null,
      trigger: null,
    },
  ]);
});

test("should downsample a long timeline to its per-bucket context peaks", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => claude(`r${index}`, index, 0));
  const timeline = readSessionCacheUsage("claude", bytes(rows)).timeline ?? [];
  expect(timeline).toHaveLength(200);
  expect(timeline[0]?.context_tokens).toBe(14);
  expect(timeline.at(-1)?.context_tokens).toBe(1009);
  expect(timeline.at(-1)?.request).toBe(1000);
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
          output_tokens: 300,
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
  expect(result.output_tokens).toBe(300);
  expect(result.compactions).toEqual([]);
  expect(result.timeline).toHaveLength(1);
  const invalid = {
    ...row,
    payload: {
      ...row.payload,
      info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 99 } },
    },
  };
  expect(readSessionCacheUsage("codex", bytes([invalid])).latest).toBeNull();
});

test("should measure Codex context as the request's total tokens against its reported window", () => {
  const rollout =
    '{"timestamp":"2026-11-12T11:35:37.824Z","ordinal":1866,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":52689422,"cached_input_tokens":52406144,"cache_write_input_tokens":0,"output_tokens":101125,"reasoning_output_tokens":58863,"total_tokens":52790547},"last_token_usage":{"input_tokens":351714,"cached_input_tokens":351488,"cache_write_input_tokens":0,"output_tokens":91,"reasoning_output_tokens":0,"total_tokens":351805},"last_usage_includes_reasoning":true,"model_context_window":475000}}}';
  const result = readSessionCacheUsage("codex", new TextEncoder().encode(rollout));
  expect(result.latest).toEqual({
    input_tokens: 351_714,
    cached_input_tokens: 351_488,
    cache_write_tokens: 0,
    recorded_at: "2026-11-12T11:35:37.824Z",
    may_be_cold_after: null,
    context_tokens: 351_805,
    context_window: 475_000,
  });
  expect(result.timeline?.[0]?.context_tokens).toBe(351_805);
});

test("should hide unsupported, malformed or unreported cache evidence rather than invent zeroes or expiry", () => {
  for (const provider of ["cursor", "cursor-agent", "gemini", "opencode"])
    expect(readSessionCacheUsage(provider, bytes([claude("one", 80, 10)]))).toEqual({
      latest: null,
      totals: null,
      output_tokens: null,
      requests: null,
      compactions: null,
      timeline: null,
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

test("should read Pi usage and context edits on the active branch", () => {
  const header = {
    type: "session",
    version: 3,
    id: "00000000-0000-4000-8000-000000000001",
    timestamp: "2026-11-06T12:00:00Z",
    cwd: "/tmp",
  };
  const assistant = (id: string, parentId: string | null, timestamp: string, usage: unknown) => ({
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "assistant", content: [], usage },
  });
  const edit = {
    type: "context_edit",
    id: "edit",
    parentId: "m1",
    timestamp: "2026-11-06T12:10:00Z",
    targetId: "m1",
    replacement: { content: [] },
  };
  const result = readSessionCacheUsage(
    "pi",
    bytes([
      header,
      assistant("m1", null, "2026-11-06T12:01:00Z", {
        input: 100,
        output: 20,
        cacheRead: 900,
        cacheWrite: 50,
      }),
      edit,
      assistant("m2", "edit", "2026-11-06T12:11:00Z", {
        input: 10,
        output: 5,
        cacheRead: 40,
        cacheWrite: 0,
      }),
    ]),
  );
  expect(result.timeline?.map((point) => point.context_tokens)).toEqual([1050, 50]);
  expect(result.totals).toEqual({
    input_tokens: 1100,
    cached_input_tokens: 940,
    cache_write_tokens: 50,
  });
  expect(result.output_tokens).toBe(25);
  expect(result.requests).toBe(2);
  expect(result.compactions).toEqual([
    {
      recorded_at: "2026-11-06T12:10:00.000Z",
      pre_tokens: null,
      post_tokens: null,
      trigger: null,
    },
  ]);
});

test("should read OpenCode request usage from its database", async () => {
  const rows = [
    {
      id: "m1",
      type: "assistant",
      time_created: 1_000,
      data: JSON.stringify({
        role: "assistant",
        model: { providerID: "anthropic", modelID: "claude" },
        time: { created: 1_000 },
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 400, write: 50 } },
      }),
    },
    {
      id: "m2",
      type: "compaction",
      time_created: 2_000,
      data: JSON.stringify({
        role: "assistant",
        model: { providerID: "anthropic", modelID: "claude" },
        time: { created: 2_000 },
        tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    },
    {
      id: "m3",
      type: "compaction",
      time_created: 3_000,
      data: JSON.stringify({ trigger: "manual" }),
    },
  ];
  const result = await loadSessionCacheUsage(
    {
      isFile: async () => true,
      readFile: async () => new Uint8Array(),
      sqliteQuery: async <T extends object>() => rows as T[],
    },
    "opencode",
    "opencode.db",
    "session-1",
  );
  expect(result.latest).toMatchObject({
    input_tokens: 20,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
  });
  expect(result.totals).toEqual({
    input_tokens: 570,
    cached_input_tokens: 400,
    cache_write_tokens: 50,
  });
  expect(result.output_tokens).toBe(15);
  expect(result.requests).toBe(2);
  expect(result.timeline?.map((point) => point.context_tokens)).toEqual([550, 20]);
  expect(result.compactions).toEqual([
    // The compaction message records no reason, so the trigger stays unknown.
    {
      recorded_at: new Date(2_000).toISOString(),
      pre_tokens: null,
      post_tokens: null,
      trigger: null,
    },
    // An explicit stored reason is honoured rather than guessed.
    {
      recorded_at: new Date(3_000).toISOString(),
      pre_tokens: null,
      post_tokens: null,
      trigger: "manual",
    },
  ]);
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
  const missing = SessionCacheUsageSchema.parse(
    await (await req(app, "GET", "/sessions/live/cache-missing/cache")).json(),
  );
  expect(missing).toEqual({
    latest: null,
    totals: null,
    output_tokens: null,
    requests: null,
    compactions: null,
    timeline: null,
  });
});
