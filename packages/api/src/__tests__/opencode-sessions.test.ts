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
db.run(
  "INSERT INTO session VALUES ('ses_main', NULL, '/work/app', 'Fix login', 1000, 5000, 10, 20, 5)",
);
db.run(
  "INSERT INTO session VALUES ('ses_child', 'ses_main', '/work/app', 'Subagent', 1100, 1200, 0, 0, 0)",
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
db.close();

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("should list top-level OpenCode sessions with folder, tokens and the shared database path", async () => {
  const records = await opencodeAdapter(dbPath, runtime).list(new Map());
  expect(records).toEqual([
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
    },
  ]);
});

test("should return no sessions when OpenCode is not installed", async () => {
  expect(await opencodeAdapter(join(dir, "missing.db"), runtime).list(new Map())).toEqual([]);
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

test("should reject a session id that could escape the SQL literal", async () => {
  await expect(opencodeTranscriptBytes(runtime, dbPath, "x' OR '1'='1")).rejects.toThrow(
    /Malformed/,
  );
});
