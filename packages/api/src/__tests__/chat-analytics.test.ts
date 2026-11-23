import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatThreadSchema } from "@orc/core/chat";
import { ChatAnalyticsSchema } from "@orc/core/chat-analytics";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import {
  chatAnalyticsFor,
  readChatAnalytics,
  readChatContext,
  skillLoaded,
} from "../sessions/chat-analytics";
import { LIVE_CHAT_ID } from "../sessions/common";
import { req, setupTestApp, teardownTestApp } from "./helpers";

const now = Date.now();
const thread = ChatThreadSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Session analytics",
  config: { agent: "claude", model: "claude-sonnet-4-5" },
  cwd: "/tmp",
  host: null,
  runtimeId: "native-analytics-1",
  backend: "claude",
  sourceId: null,
  updatedAt: now,
  messages: [
    {
      id: "q1",
      role: "user",
      content: "Fix the rounding.",
      timestamp: now - 120_000,
    },
    {
      id: "a1",
      role: "assistant",
      content: "Updated the cart total and added a test.",
      timestamp: now - 60_000,
      turn: {
        startedAt: now - 100_000,
        finishedAt: now - 60_000,
        durationMs: 40_000,
        outcome: "completed",
      },
      activity: [
        { type: "tool", id: "t1", name: "Read", input: "src/cart.ts" },
        { type: "tool", id: "t2", name: "Edit", input: "src/cart.ts", result: "ok" },
        { type: "tool", id: "t3", name: "Bash", input: "bun test", isError: true, result: "fail" },
      ],
    },
    {
      id: "a2",
      role: "assistant",
      content: "Retried and the suite passes.",
      timestamp: now - 10_000,
      turn: {
        startedAt: now - 20_000,
        finishedAt: now - 10_000,
        durationMs: 10_000,
        outcome: "completed",
      },
      activity: [{ type: "tool", id: "t4", name: "Bash", input: "bun test", result: "ok" }],
    },
  ],
});

test("should summarize chat turns and tool activity for every agent", () => {
  const analytics = readChatAnalytics(thread);
  expect(analytics).toMatchObject({
    messages: 3,
    userMessages: 1,
    assistantMessages: 2,
    turns: 2,
    toolCalls: 4,
    toolFailures: 1,
    outcomes: { completed: 2, stopped: 0, failed: 0, running: 0 },
    durations: { averageMs: 25_000, medianMs: 10_000, p95Ms: 40_000, totalMs: 50_000 },
  });
  expect(analytics.tools).toEqual([
    { name: "Bash", calls: 2, failures: 1 },
    { name: "Edit", calls: 1, failures: 0 },
    { name: "Read", calls: 1, failures: 0 },
  ]);
  expect(analytics.toolTotal).toBe(3);
  expect(analytics.turnTimeline.map((turn) => [turn.index, turn.toolCalls])).toEqual([
    [1, 3],
    [2, 1],
  ]);
});

test("should recognize a skill load from each agent's own tool call", () => {
  expect(skillLoaded("Skill", '{"skill":"nir-collab"}')).toBe("nir-collab");
  expect(skillLoaded("mcp__orc__skill_read", '{"name":"orc-sdlc"}')).toBe("orc-sdlc");
  expect(
    skillLoaded("mcp__orc__tool_invoke", '{"name":"skill_read","arguments":{"name":"orc-tasks"}}'),
  ).toBe("orc-tasks");
  expect(skillLoaded("tool_invoke", '{"name":"task_list","arguments":{"name":"x"}}')).toBeNull();
  expect(skillLoaded("Read", '{"file_path":"/Users/n/.claude/skills/orc-track/SKILL.md"}')).toBe(
    "orc-track",
  );
  expect(
    skillLoaded(
      "exec",
      'text(await tools.exec_command({cmd:"cat /Users/n/.agents/skills/nir-collab/SKILL.md"}))',
    ),
  ).toBe("nir-collab");
  expect(skillLoaded("Bash", '{"command":"sed -n 1,80p skills/orc-release/SKILL.md"}')).toBe(
    "orc-release",
  );
  expect(skillLoaded("Bash", '{"command":"git add skills/orc-release/SKILL.md"}')).toBeNull();
  expect(skillLoaded("Bash", '{"command":"sed -i \'\' s/a/b/ skills/x/SKILL.md"}')).toBeNull();
  expect(skillLoaded("Bash", '{"command":"cat > skills/x/SKILL.md <<EOF"}')).toBeNull();
  expect(skillLoaded("Edit", '{"file_path":"skills/orc-release/SKILL.md"}')).toBeNull();
  expect(skillLoaded("Skill", "not json")).toBeNull();
});

test("should count skill loads per skill, most used first", () => {
  const tool = (id: string, name: string, input: string) => ({ type: "tool", id, name, input });
  const analytics = readChatAnalytics(
    ChatThreadSchema.parse({
      ...thread,
      messages: [
        {
          id: "a",
          role: "assistant",
          content: "done",
          timestamp: now,
          activity: [
            tool("1", "Skill", '{"skill":"orc-track"}'),
            tool("2", "Skill", '{"skill":"nir-collab"}'),
            tool("3", "Skill", '{"skill":"nir-collab"}'),
            tool("4", "Bash", '{"command":"ls"}'),
          ],
        },
      ],
    }),
  );
  expect(analytics.skills).toEqual([
    { name: "nir-collab", loads: 2 },
    { name: "orc-track", loads: 1 },
  ]);
});

test("should explain an unsupported native context source without failing the chat analytics", async () => {
  const context = await readChatContext(
    { isFile: async () => true, readFile: async () => new Uint8Array() },
    thread,
    {
      backend: "gemini",
      model: null,
      transcript_path: "/tmp/session.json",
      runtime_session_id: "native-analytics-1",
    },
  );
  expect(context).toMatchObject({
    backend: "gemini",
    supported: false,
    reason: expect.stringContaining("Gemini"),
  });
  expect(context?.usage.latest).toBeNull();
});

test("should reuse a parsed transcript until the file changes", async () => {
  const path = join(root, "reused-transcript.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "assistant",
      timestamp: new Date(now - 60_000).toISOString(),
      message: {
        id: "usage-cache",
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 0,
        },
      },
    })}\n`,
  );
  let reads = 0;
  let size = 1;
  const runtime = {
    isFile: async () => true,
    readFile: async () => {
      reads += 1;
      return new Uint8Array(await Bun.file(path).arrayBuffer());
    },
    stat: async () => ({ path, size, mtimeMs: size, birthtimeMs: 0 }),
  };
  const source = {
    backend: "claude",
    model: null,
    transcript_path: path,
    runtime_session_id: "native-reuse-1",
  };
  const first = await readChatContext(runtime, thread, source);
  const second = await readChatContext(runtime, thread, source);
  expect(reads).toBe(1);
  expect(second?.usage.latest?.input_tokens).toBe(first?.usage.latest?.input_tokens);
  size = 2;
  await readChatContext(runtime, thread, source);
  expect(reads).toBe(2);
});

let app: ReturnType<typeof setupTestApp>;
const root = mkdtempSync(join(tmpdir(), "orc-chat-analytics-"));
beforeAll(() => {
  app = setupTestApp();
});
afterAll(async () => {
  teardownTestApp();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("should serve chat analytics with native context and cache usage", async () => {
  const path = join(root, "transcript.jsonl");
  writeFileSync(
    path,
    JSON.stringify({
      type: "assistant",
      timestamp: new Date(now - 60_000).toISOString(),
      message: {
        id: "usage-1",
        model: "claude",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 50,
        },
      },
    }),
  );
  const sqlite = getSqlite();
  sqlite.run(
    "INSERT OR IGNORE INTO bridge_chats (id, platform, chat_id) VALUES (?, 'telegram', ?)",
    [LIVE_CHAT_ID, LIVE_CHAT_ID],
  );
  sqlite.run(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, transcript_path, model) VALUES ('live-analytics', ?, 'claude', 'direct', 'native-analytics-1', ?, 'claude-sonnet-4-5')",
    [LIVE_CHAT_ID, path],
  );
  new ChatStore(sqlite).save(thread);

  expect((await app.request(`/api/chat/threads/${thread.id}/analytics`)).status).toBe(401);
  const response = await req(app, "GET", `/chat/threads/${thread.id}/analytics`);
  expect(response.status).toBe(200);
  const analytics = ChatAnalyticsSchema.parse(await response.json());
  expect(analytics.toolCalls).toBe(4);
  expect(analytics.context).toMatchObject({
    backend: "claude",
    model: "claude-sonnet-4-5",
    supported: true,
    reason: null,
  });
  expect(analytics.context?.usage.latest?.input_tokens).toBe(550);
  expect(analytics.context?.usage.latest?.cached_input_tokens).toBe(400);
  expect(analytics.context?.usage.requests).toBe(1);
});

test("should serve the same analytics from the session page", async () => {
  const response = await req(app, "GET", "/sessions/live/live-analytics/analytics");
  expect(response.status).toBe(200);
  const analytics = ChatAnalyticsSchema.parse(await response.json());
  expect(analytics.toolCalls).toBe(4);
  expect(analytics.context?.backend).toBe("claude");
  expect((await req(app, "GET", "/sessions/live/unknown-session/analytics")).status).toBe(404);
});

function claudeLine(
  id: string,
  ts: number,
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    thinking_tokens?: number;
  },
) {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(ts).toISOString(),
    message: {
      id,
      model,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        ...(usage.thinking_tokens !== undefined
          ? { output_tokens_details: { thinking_tokens: usage.thinking_tokens } }
          : {}),
      },
    },
  });
}

function makeTurnMessages(baseTs: number, turns: Array<{ model?: string; durationMs?: number }>) {
  return turns.flatMap((entry, idx) => {
    const start = baseTs + idx * 60_000;
    const durationMs = entry.durationMs ?? 20_000;
    const finish = start + durationMs;
    return [
      {
        id: `u-${idx + 1}`,
        role: "user" as const,
        content: `Prompt ${idx + 1}`,
        timestamp: start - 1_000,
      },
      {
        id: `a-${idx + 1}`,
        role: "assistant" as const,
        content: `Answer ${idx + 1}`,
        timestamp: finish,
        ...(entry.model ? { model: entry.model } : {}),
        turn: {
          startedAt: start,
          finishedAt: finish,
          durationMs,
          outcome: "completed" as const,
        },
      },
    ];
  });
}

function memoryRuntime(content: string) {
  const bytes = new TextEncoder().encode(content);
  return {
    isFile: async () => true,
    readFile: async () => bytes,
  };
}

test("should attribute a 5-turn Claude chat with multi-request summing, unreadable turns, unattributed bucket and cost", async () => {
  const base = now - 600_000;
  const fiveTurnThread = ChatThreadSchema.parse({
    id: "22222222-2222-4222-8222-222222222222",
    title: "Five turns",
    config: { agent: "claude", model: "claude-sonnet-4-5" },
    cwd: "/tmp",
    host: null,
    runtimeId: "native-5-turns",
    backend: "claude",
    sourceId: null,
    updatedAt: now,
    messages: makeTurnMessages(base, [
      { model: "claude-sonnet-4-5" },
      { model: "claude-sonnet-4-5" },
      { model: "claude-sonnet-4-5" },
      { model: "claude-sonnet-4-5" },
      { model: "claude-sonnet-4-5" },
    ]),
  });

  const transcript = [
    claudeLine("pre-0", base - 120_000, "claude-sonnet-4-5", {
      input_tokens: 1_000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 500,
    }),
    claudeLine("t1-r1", base + 10_000, "claude-sonnet-4-5", {
      input_tokens: 2_000,
      output_tokens: 1_000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 2_000,
      thinking_tokens: 300,
    }),
    claudeLine("t2-r1", base + 65_000, "claude-sonnet-4-5", {
      input_tokens: 1_500,
      output_tokens: 400,
      cache_read_input_tokens: 12_000,
      cache_creation_input_tokens: 1_000,
    }),
    claudeLine("t2-r2", base + 75_000, "claude-sonnet-4-5", {
      input_tokens: 500,
      output_tokens: 600,
      cache_read_input_tokens: 14_000,
      cache_creation_input_tokens: 0,
    }),
    claudeLine("t3-r1", base + 130_000, "claude-sonnet-4-5", {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_read_input_tokens: 15_000,
      cache_creation_input_tokens: 0,
    }),
    claudeLine("t5-r1", base + 250_000, "claude-sonnet-4-5", {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_read_input_tokens: 19_000,
      cache_creation_input_tokens: 0,
    }),
  ].join("\n");

  const analytics = ChatAnalyticsSchema.parse(
    await chatAnalyticsFor(
      fiveTurnThread,
      {
        backend: "claude",
        model: "claude-sonnet-4-5",
        transcript_path: "/tmp/5turns.jsonl",
        runtime_session_id: "native-5-turns",
      },
      memoryRuntime(transcript),
      {},
    ),
  );

  expect(analytics.turnTimeline).toHaveLength(5);
  expect(analytics.turnTimeline[0]).toMatchObject({
    index: 1,
    model: "claude-sonnet-4-5",
    usageSource: "recorded",
    usage: {
      input: 2_000,
      output: 700,
      reasoning: 300,
      cacheRead: 10_000,
      cacheWrite: 2_000,
      total: 15_000,
    },
  });
  expect(analytics.turnTimeline[1]?.usage).toEqual({
    input: 2_000,
    output: 1_000,
    reasoning: 0,
    cacheRead: 26_000,
    cacheWrite: 1_000,
    total: 30_000,
  });
  expect(analytics.turnTimeline[3]).toMatchObject({
    index: 4,
    usage: null,
    costUsd: null,
    usageSource: "unreadable",
  });
  expect(analytics.usage.unattributedRequests).toBe(1);
  expect(analytics.usage.unattributed).toEqual({
    input: 1_000,
    output: 200,
    cacheRead: 0,
    cacheWrite: 500,
    reasoning: 0,
    total: 1_700,
  });
  expect(analytics.usage.attributed?.total).toBe(15_000 + 30_000 + 16_500 + 20_500);
  expect(analytics.usage.totals?.total).toBe(
    (analytics.usage.attributed?.total ?? 0) + (analytics.usage.unattributed?.total ?? 0),
  );
  expect(analytics.usage.costComplete).toBe(true);
  expect(analytics.usage.totalCostUsd).toBeGreaterThan(0);
  expect(analytics.usage.cacheSavingsUsd).toBeGreaterThan(0);
  expect(analytics.usage.cacheHitRate).toBeCloseTo(70_000 / (7_000 + 70_000 + 3_500), 6);
});

test("should split tokens and cost by model when a chat switches models mid-session", async () => {
  const base = now - 600_000;
  const switchThread = ChatThreadSchema.parse({
    id: "33333333-3333-4333-8333-333333333333",
    title: "Model switch",
    config: { agent: "claude", model: "claude-opus-4-1" },
    cwd: "/tmp",
    host: null,
    runtimeId: "native-switch",
    backend: "claude",
    sourceId: null,
    updatedAt: now,
    messages: makeTurnMessages(base, [
      { model: "claude-sonnet-4-5" },
      { model: "claude-sonnet-4-5" },
      { model: "claude-opus-4-1" },
    ]),
  });

  const transcript = [
    claudeLine("s1", base + 10_000, "claude-sonnet-4-5", {
      input_tokens: 10_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 20_000,
      cache_creation_input_tokens: 5_000,
    }),
    claudeLine("s2", base + 70_000, "claude-sonnet-4-5", {
      input_tokens: 10_000,
      output_tokens: 3_000,
      cache_read_input_tokens: 30_000,
      cache_creation_input_tokens: 0,
    }),
    claudeLine("o1", base + 130_000, "claude-opus-4-1", {
      input_tokens: 20_000,
      output_tokens: 4_000,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 0,
    }),
  ].join("\n");

  const analytics = await chatAnalyticsFor(
    switchThread,
    {
      backend: "claude",
      model: "claude-opus-4-1",
      transcript_path: "/tmp/switch.jsonl",
      runtime_session_id: "native-switch",
    },
    memoryRuntime(transcript),
    {},
  );

  expect(analytics.turnTimeline.map((t) => t.model)).toEqual([
    "claude-sonnet-4-5",
    "claude-sonnet-4-5",
    "claude-opus-4-1",
  ]);
  expect(analytics.usage.byModel).toHaveLength(2);
  const sonnet = analytics.usage.byModel.find((m) => m.model === "claude-sonnet-4-5");
  const opus = analytics.usage.byModel.find((m) => m.model === "claude-opus-4-1");
  expect(sonnet?.turns).toBe(2);
  expect(opus?.turns).toBe(1);
  expect(sonnet?.costUsd).toBe(0.16875);
  expect(opus?.costUsd).toBe(0.675);
  expect(analytics.usage.totalCostUsd).toBe(0.84375);
  expect(analytics.usage.totals?.total).toBe((sonnet?.usage.total ?? 0) + (opus?.usage.total ?? 0));
});

test("should return null cost for unpriced models (never $0) and honor config pricing overrides", async () => {
  const base = now - 300_000;
  const unpricedThread = ChatThreadSchema.parse({
    id: "44444444-4444-4444-8444-444444444444",
    title: "Unpriced model",
    config: { agent: "claude", model: "acme/unpriced-v1" },
    cwd: "/tmp",
    host: null,
    runtimeId: "native-unpriced",
    backend: "claude",
    sourceId: null,
    updatedAt: now,
    messages: makeTurnMessages(base, [{ model: "acme/unpriced-v1" }]),
  });

  const transcript = claudeLine("u1", base + 5_000, "acme/unpriced-v1", {
    input_tokens: 50_000,
    output_tokens: 10_000,
    cache_read_input_tokens: 100_000,
    cache_creation_input_tokens: 0,
  });

  const withoutPrice = await chatAnalyticsFor(
    unpricedThread,
    {
      backend: "claude",
      model: "acme/unpriced-v1",
      transcript_path: "/tmp/unpriced.jsonl",
      runtime_session_id: "native-unpriced",
    },
    memoryRuntime(transcript),
    {},
  );
  expect(withoutPrice.turnTimeline[0]?.usageSource).toBe("recorded");
  expect(withoutPrice.turnTimeline[0]?.usage?.total).toBe(160_000);
  expect(withoutPrice.turnTimeline[0]?.costUsd).toBeNull();
  expect(withoutPrice.usage.totalCostUsd).toBeNull();
  expect(withoutPrice.usage.cacheSavingsUsd).toBeNull();
  expect(withoutPrice.usage.costComplete).toBe(false);
  expect(withoutPrice.usage.byModel[0]?.costUsd).toBeNull();

  const withOverride = await chatAnalyticsFor(
    unpricedThread,
    {
      backend: "claude",
      model: "acme/unpriced-v1",
      transcript_path: "/tmp/unpriced.jsonl",
      runtime_session_id: "native-unpriced",
    },
    memoryRuntime(transcript),
    {
      "acme/unpriced-v1": {
        inputPerMillion: 2,
        outputPerMillion: 8,
        cacheReadPerMillion: 0.2,
      },
    },
  );
  expect(withOverride.turnTimeline[0]?.costUsd).toBe(0.2);
  expect(withOverride.usage.totalCostUsd).toBe(0.2);
  expect(withOverride.usage.cacheSavingsUsd).toBe(0.18);
  expect(withOverride.usage.costComplete).toBe(true);
});

test("should label Cursor sessions estimated and keep cost unknown unless explicitly configured", async () => {
  const base = now - 300_000;
  const cursorThread = ChatThreadSchema.parse({
    id: "55555555-5555-4555-8555-555555555555",
    title: "Cursor session",
    config: { agent: "cursor", model: "claude-sonnet-4-5" },
    cwd: "/tmp",
    host: null,
    runtimeId: "native-cursor",
    backend: "cursor",
    sourceId: null,
    updatedAt: now,
    messages: makeTurnMessages(base, [{ model: "claude-sonnet-4-5" }]),
  });

  const cursorSource = {
    backend: "cursor",
    model: "claude-sonnet-4-5",
    transcript_path: null,
    runtime_session_id: "native-cursor",
    tokens_used: 25_000,
  };

  const defaultCursor = await chatAnalyticsFor(cursorThread, cursorSource, memoryRuntime(""), {});
  expect(defaultCursor.context?.supported).toBe(false);
  expect(defaultCursor.usage.usageSource).toBe("estimated");
  expect(defaultCursor.usage.totals?.total).toBe(25_000);
  expect(defaultCursor.usage.unattributed?.total).toBe(25_000);
  expect(defaultCursor.usage.cacheHitRate).toBeNull();
  expect(defaultCursor.usage.totalCostUsd).toBeNull();
  expect(defaultCursor.usage.byModel[0]).toMatchObject({
    model: "claude-sonnet-4-5",
    usageSource: "estimated",
    cacheHitRate: null,
    costUsd: null,
  });

  const configuredCursor = await chatAnalyticsFor(cursorThread, cursorSource, memoryRuntime(""), {
    "claude-sonnet-4-5": {
      inputPerMillion: 4,
      outputPerMillion: 16,
    },
  });
  expect(configuredCursor.usage.usageSource).toBe("estimated");
  expect(configuredCursor.usage.totalCostUsd).toBe(0.1);
});

test("should keep payload bounded for a 200-turn chat while preserving full session totals", async () => {
  const base = now - 200 * 60_000;
  const turns = Array.from({ length: 200 }, () => ({ model: "claude-sonnet-4-5" }));
  const longThread = ChatThreadSchema.parse({
    id: "66666666-6666-4666-8666-666666666666",
    title: "200 turns",
    config: { agent: "claude", model: "claude-sonnet-4-5" },
    cwd: "/tmp",
    host: null,
    runtimeId: "native-200",
    backend: "claude",
    sourceId: null,
    updatedAt: now,
    messages: makeTurnMessages(base, turns),
  });
  const transcript = turns
    .map((_, idx) =>
      claudeLine(`long-${idx}`, base + idx * 60_000 + 5_000, "claude-sonnet-4-5", {
        input_tokens: 1_000,
        output_tokens: 200,
        cache_read_input_tokens: 5_000,
        cache_creation_input_tokens: 100,
      }),
    )
    .join("\n");

  const analytics = ChatAnalyticsSchema.parse(
    await chatAnalyticsFor(
      longThread,
      {
        backend: "claude",
        model: "claude-sonnet-4-5",
        transcript_path: "/tmp/200.jsonl",
        runtime_session_id: "native-200",
      },
      memoryRuntime(transcript),
      {},
    ),
  );

  expect(analytics.turns).toBe(200);
  expect(analytics.turnTimeline).toHaveLength(80);
  expect(analytics.turnTimelineTruncated).toBe(true);
  expect(analytics.turnTimeline[0]?.index).toBe(121);
  expect(analytics.turnTimeline.at(-1)?.index).toBe(200);
  expect(analytics.usage.totals?.total).toBe(200 * 6_300);
  expect(analytics.usage.byModel[0]?.turns).toBe(200);
  expect(JSON.stringify(analytics).length).toBeLessThan(65_536);
});

test("should prefer non-generic transcript model over CLI alias on assistant message", async () => {
  const base = now - 300_000;
  const aliasThread = ChatThreadSchema.parse({
    id: "77777777-7777-4777-8777-777777777777",
    title: "Alias model",
    config: { agent: "claude", model: "opus[1m]" },
    cwd: "/tmp",
    host: null,
    runtimeId: "native-alias",
    backend: "claude",
    sourceId: null,
    updatedAt: now,
    messages: makeTurnMessages(base, [{ model: "opus[1m]" }]),
  });

  const transcript = claudeLine("alias-1", base + 5_000, "claude-opus-4-6", {
    input_tokens: 100_000,
    output_tokens: 10_000,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });

  const analytics = await chatAnalyticsFor(
    aliasThread,
    {
      backend: "claude",
      model: "opus[1m]",
      transcript_path: "/tmp/alias.jsonl",
      runtime_session_id: "native-alias",
    },
    memoryRuntime(transcript),
    {},
  );

  expect(analytics.turnTimeline[0]?.model).toBe("claude-opus-4-6");
  expect(analytics.turnTimeline[0]?.costUsd).toBe(0.75);
  expect(analytics.usage.byModel[0]?.model).toBe("claude-opus-4-6");
  expect(analytics.usage.totalCostUsd).toBe(0.75);
});

test("should net cache-write surcharges against cache-read savings at the bucket level", async () => {
  const base = now - 300_000;
  const cacheThread = ChatThreadSchema.parse({
    id: "88888888-8888-4888-8888-888888888888",
    title: "Cache write netting",
    config: { agent: "claude", model: "claude-sonnet-4-5" },
    cwd: "/tmp",
    host: null,
    runtimeId: "native-cache-net",
    backend: "claude",
    sourceId: null,
    updatedAt: now,
    messages: makeTurnMessages(base, [
      { model: "claude-sonnet-4-5" },
      { model: "claude-sonnet-4-5" },
      { model: "claude-sonnet-4-5" },
    ]),
  });

  const transcript = [
    claudeLine("cw-1", base + 5_000, "claude-sonnet-4-5", {
      input_tokens: 1_000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 100_000,
    }),
    claudeLine("cw-2", base + 65_000, "claude-sonnet-4-5", {
      input_tokens: 1_000,
      output_tokens: 100,
      cache_read_input_tokens: 20_000,
      cache_creation_input_tokens: 0,
    }),
    claudeLine("cw-3", base + 125_000, "claude-sonnet-4-5", {
      input_tokens: 1_000,
      output_tokens: 100,
      cache_read_input_tokens: 20_000,
      cache_creation_input_tokens: 0,
    }),
  ].join("\n");

  const twoTurns = ChatThreadSchema.parse({
    ...cacheThread,
    messages: cacheThread.messages.slice(0, 4),
  });
  const afterTwo = await chatAnalyticsFor(
    twoTurns,
    {
      backend: "claude",
      model: "claude-sonnet-4-5",
      transcript_path: "/tmp/cw2.jsonl",
      runtime_session_id: "native-cache-net-2",
    },
    memoryRuntime(transcript.split("\n").slice(0, 2).join("\n")),
    {},
  );
  expect(afterTwo.usage.cacheSavingsUsd).toBe(0);

  const afterThree = await chatAnalyticsFor(
    cacheThread,
    {
      backend: "claude",
      model: "claude-sonnet-4-5",
      transcript_path: "/tmp/cw3.jsonl",
      runtime_session_id: "native-cache-net-3",
    },
    memoryRuntime(transcript),
    {},
  );
  expect(afterThree.usage.cacheSavingsUsd).toBe(0.033);
  expect(afterThree.usage.byModel[0]?.cacheSavingsUsd).toBe(0.033);
});

test("should persist model_pricing overrides through settings and apply them to GET /chat/threads/:id/analytics", async () => {
  const base = now - 300_000;
  const savedThread = ChatThreadSchema.parse({
    id: "99999999-9999-4999-8999-999999999999",
    title: "Configured pricing E2E",
    config: { agent: "claude", model: "acme/saved-model" },
    cwd: "/tmp",
    host: null,
    runtimeId: "native-saved-pricing",
    backend: "claude",
    sourceId: null,
    updatedAt: now,
    messages: makeTurnMessages(base, [{ model: "acme/saved-model" }]),
  });
  const transcriptPath = join(root, "saved-pricing.jsonl");
  writeFileSync(
    transcriptPath,
    claudeLine("sp-1", base + 5_000, "acme/saved-model", {
      input_tokens: 100_000,
      output_tokens: 10_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }),
  );
  const sqlite = getSqlite();
  sqlite.run(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, transcript_path, model) VALUES ('live-saved-pricing', ?, 'claude', 'direct', 'native-saved-pricing', ?, 'acme/saved-model')",
    [LIVE_CHAT_ID, transcriptPath],
  );
  new ChatStore(sqlite).save(savedThread);

  const beforeResponse = await req(app, "GET", `/chat/threads/${savedThread.id}/analytics`);
  expect(beforeResponse.status).toBe(200);
  const before = ChatAnalyticsSchema.parse(await beforeResponse.json());
  expect(before.usage.totalCostUsd).toBeNull();
  expect(before.turnTimeline[0]?.costUsd).toBeNull();

  const patch = await req(app, "PATCH", "/settings", {
    model_pricing: {
      "acme/saved-model": {
        inputPerMillion: 5,
        outputPerMillion: 20,
        cacheReadPerMillion: 0.5,
        cacheWritePerMillion: 6,
      },
    },
  });
  expect(patch.status).toBe(200);
  const saved = (await patch.json()) as { model_pricing?: Record<string, unknown> };
  expect(saved.model_pricing?.["acme/saved-model"]).toEqual({
    inputPerMillion: 5,
    outputPerMillion: 20,
    cacheReadPerMillion: 0.5,
    cacheWritePerMillion: 6,
  });

  const afterResponse = await req(app, "GET", `/chat/threads/${savedThread.id}/analytics`);
  expect(afterResponse.status).toBe(200);
  const after = ChatAnalyticsSchema.parse(await afterResponse.json());
  expect(after.usage.totalCostUsd).toBe(0.7);
  expect(after.turnTimeline[0]?.costUsd).toBe(0.7);
});
