import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatThreadSchema } from "@orc/core/chat";
import { ChatAnalyticsSchema } from "@orc/core/chat-analytics";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import { readChatAnalytics, readChatContext, skillLoaded } from "../sessions/chat-analytics";
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
