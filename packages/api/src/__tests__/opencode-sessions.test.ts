import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { opencodeAdapter, opencodeTranscriptBytes } from "../sessions/opencode.js";
import { readTranscriptBytes } from "../sessions/transcript.js";
import { loadTranscriptBytes } from "../sessions/transcript-source.js";

const dir = mkdtempSync(join(tmpdir(), "orc-opencode-"));
const dbPath = join(dir, "opencode.db");
const runtime = hostRuntime(LOCAL_HOST);

const db = new Database(dbPath);
db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER)`);
db.run(
  "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
);
db.run(
  "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
);
db.run(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER)`);
db.run(
  "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)",
);
db.run(
  "INSERT INTO session VALUES ('ses_main', NULL, '/work/app', 'Fix login', 1000, 5000, 10, 20, 5)",
);
db.run(
  "INSERT INTO session VALUES ('ses_child', 'ses_main', '/work/app', 'Subagent', 1100, 1200, 0, 0, 0)",
);
db.run(
  "INSERT INTO session_v2 VALUES ('ses_v2', NULL, '/work/api', 'Migrate storage', 6000, 9000, 1, 2, 3)",
);
const message = (id: string, time: number, role: string) =>
  db.run("INSERT INTO message VALUES (?, 'ses_main', ?, ?)", [id, time, JSON.stringify({ role })]);
const part = (id: string, messageId: string, time: number, data: object) =>
  db.run("INSERT INTO part VALUES (?, ?, 'ses_main', ?, ?)", [
    id,
    messageId,
    time,
    JSON.stringify(data),
  ]);
message("msg_1", 2000, "user");
part("prt_1", "msg_1", 2000, { type: "text", text: "why does login fail?" });
part("prt_2", "msg_1", 2001, { type: "text", text: "injected", synthetic: true });
message("msg_2", 3000, "assistant");
part("prt_3", "msg_2", 3000, { type: "step-start" });
part("prt_4", "msg_2", 3001, { type: "reasoning", text: "check the handler" });
part("prt_5", "msg_2", 3002, {
  type: "tool",
  tool: "read",
  callID: "call_1",
  state: { status: "completed", input: { filePath: "/work/app/login.ts" }, output: "export {}" },
});
part("prt_6", "msg_2", 3003, { type: "text", text: "The token expires early." });
const v2Message = (id: string, type: string, seq: number, time: number, data: object) =>
  db.run("INSERT INTO session_message VALUES (?, 'ses_v2', ?, ?, ?, ?)", [
    id,
    type,
    seq,
    time,
    JSON.stringify(data),
  ]);
v2Message("msg_v2_1", "user", 1, 7000, {
  time: { created: 7000 },
  text: "why does search fail?",
  files: [],
});
v2Message("msg_v2_2", "user", 2, 7001, {
  time: { created: 7001 },
  text: "injected context",
  synthetic: true,
});
v2Message("msg_v2_3", "assistant", 3, 8000, {
  time: { created: 8000, completed: 8500 },
  agent: "build",
  content: [
    { type: "step-start" },
    { type: "reasoning", text: "check the index" },
    {
      type: "tool",
      id: "call_v2",
      name: "shell",
      state: {
        status: "completed",
        input: { command: "rg search" },
        output: "2 matches",
      },
    },
    { type: "text", text: "The index is stale." },
  ],
});
v2Message("msg_v2_4", "compaction", 4, 8600, {
  time: { created: 8600 },
  model: { providerID: "bailian-cli", id: "deepseek-v4.1-flash" },
  tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 300, write: 0 } },
  summary: "compacted context",
});
db.close();

// A database from an OpenCode version that predates the v2 tables.
const legacyDbPath = join(dir, "legacy.db");
const legacyDb = new Database(legacyDbPath);
legacyDb.run(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER)`);
legacyDb.run(
  "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
);
legacyDb.run(
  "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
);
legacyDb.run(
  "INSERT INTO session VALUES ('ses_legacy', NULL, '/work/old', 'Old install', 1000, 2000, 4, 5, 6)",
);
legacyDb.run("INSERT INTO message VALUES ('msg_l1', 'ses_legacy', 1500, ?)", [
  JSON.stringify({ role: "user" }),
]);
legacyDb.run("INSERT INTO part VALUES ('prt_l1', 'msg_l1', 'ses_legacy', 1500, ?)", [
  JSON.stringify({ type: "text", text: "hello old world" }),
]);
legacyDb.close();

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("should list OpenCode sessions from both storage generations, newest first", async () => {
  const records = await opencodeAdapter(dbPath, runtime).list(new Map());
  expect(records).toEqual([
    {
      backend: "opencode",
      externalId: "ses_v2",
      title: "Migrate storage",
      cwd: "/work/api",
      status: "stopped",
      createdAt: new Date(6000),
      lastActivityAt: new Date(9000),
      transcriptPath: dbPath,
      tokensUsed: 6,
      usageVersion: 1,
      usage: expect.any(Function),
    },
    {
      backend: "opencode",
      externalId: "ses_main",
      title: "Fix login",
      cwd: "/work/app",
      status: "stopped",
      createdAt: new Date(1000),
      lastActivityAt: new Date(5000),
      transcriptPath: dbPath,
      tokensUsed: 35,
      usageVersion: 1,
      usage: expect.any(Function),
    },
  ]);
});

test("should list legacy-only OpenCode databases without v2 tables", async () => {
  const records = await opencodeAdapter(legacyDbPath, runtime).list(new Map());
  expect(records).toEqual([
    {
      backend: "opencode",
      externalId: "ses_legacy",
      title: "Old install",
      cwd: "/work/old",
      status: "stopped",
      createdAt: new Date(1000),
      lastActivityAt: new Date(2000),
      transcriptPath: legacyDbPath,
      tokensUsed: 15,
      usageVersion: 1,
      usage: expect.any(Function),
    },
  ]);
});

test("should return no sessions when OpenCode is not installed", async () => {
  expect(await opencodeAdapter(join(dir, "missing.db"), runtime).list(new Map())).toEqual([]);
});

test("should index OpenCode compaction requests instead of dropping their tokens", async () => {
  const records = await opencodeAdapter(dbPath, runtime).list(new Map());
  const v2 = records.find((record) => record.externalId === "ses_v2");
  const usage = await v2?.usage?.();
  expect(usage?.tokens).toBe(420);
  expect(usage?.model).toBe("bailian-cli/deepseek-v4.1-flash");
  expect(usage?.events).toEqual([
    {
      key: "msg_v2_4",
      ts: 8600,
      model: "bailian-cli/deepseek-v4.1-flash",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      otherTokens: 0,
      estimated: false,
    },
  ]);
});

test("should render an OpenCode transcript with thinking, paired tool output and no synthetic text", async () => {
  const bytes = await loadTranscriptBytes(runtime, "opencode", dbPath, "ses_main");
  const page = await readTranscriptBytes(bytes, "opencode", "opencode-test", {});
  expect(page.turns).toEqual([
    {
      index: 0,
      role: "user",
      time: new Date(2000).toISOString(),
      blocks: [{ type: "text", text: "why does login fail?" }],
    },
    {
      index: 1,
      role: "assistant",
      time: new Date(3000).toISOString(),
      blocks: [
        { type: "thinking", text: "check the handler" },
        {
          type: "tool_use",
          id: "call_1",
          name: "read",
          input: '{"filePath":"/work/app/login.ts"}',
          result: "export {}",
        },
        { type: "text", text: "The token expires early." },
      ],
    },
  ]);
});

test("should render a v2 OpenCode transcript with inline parts", async () => {
  const bytes = await loadTranscriptBytes(runtime, "opencode", dbPath, "ses_v2");
  const page = await readTranscriptBytes(bytes, "opencode", "opencode-v2-test", {});
  expect(page.turns).toEqual([
    {
      index: 0,
      role: "user",
      time: new Date(7000).toISOString(),
      blocks: [{ type: "text", text: "why does search fail?" }],
    },
    {
      index: 1,
      role: "assistant",
      time: new Date(8000).toISOString(),
      blocks: [
        { type: "thinking", text: "check the index" },
        {
          type: "tool_use",
          id: "call_v2",
          name: "shell",
          input: '{"command":"rg search"}',
          result: "2 matches",
        },
        { type: "text", text: "The index is stale." },
      ],
    },
  ]);
});

test("should read a legacy transcript from a database without v2 tables", async () => {
  const bytes = await opencodeTranscriptBytes(runtime, legacyDbPath, "ses_legacy");
  const page = await readTranscriptBytes(bytes, "opencode", "opencode-legacy-test", {});
  expect(page.turns).toEqual([
    {
      index: 0,
      role: "user",
      time: new Date(1500).toISOString(),
      blocks: [{ type: "text", text: "hello old world" }],
    },
  ]);
});

test("should reject a session id that could escape the SQL literal", async () => {
  await expect(opencodeTranscriptBytes(runtime, dbPath, "x' OR '1'='1")).rejects.toThrow(
    /Malformed/,
  );
});
