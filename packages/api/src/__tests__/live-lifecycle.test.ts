import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRegistration } from "@orc/core/live-session";
import { runSync, startSessionWatcher } from "../session-watcher.js";
import { codexAdapter } from "../sessions/codex.js";
import { cursorAgentAdapter } from "../sessions/cursor-agent.js";
import { geminiAdapter } from "../sessions/gemini.js";
import { withLifecycle } from "../sessions/lifecycle.js";
import { hasWriter } from "../sessions/ownership.js";
import { readTranscript } from "../sessions/transcript.js";
import type { SessionAdapter } from "../sessions/types.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "orc-live-lifecycle-"));
let app: ReturnType<typeof setupTestApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(() => {
  teardownTestApp();
});

describe("native ownership", () => {
  test("should ignore stale lock files and release every shared probe", () => {
    const path = join(root, "stale.lock");
    writeFileSync(path, "");
    expect(hasWriter(path)).toBe(false);
    expect(hasWriter(path)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(hasWriter(join(root, "missing.lock"))).toBe(false);
  });

  test("should detect a held native lock and then observe graceful release", async () => {
    const path = join(root, "owned.lock");
    writeFileSync(path, "");
    const command =
      process.platform === "win32"
        ? [
            "powershell.exe",
            "-NoProfile",
            "-Command",
            "$file=[System.IO.File]::Open($env:ORC_TEST_LOCK,'Open','ReadWrite','ReadWrite'); $file.Lock(0,1); [Console]::WriteLine('ready'); [Console]::In.ReadLine() | Out-Null; $file.Unlock(0,1); $file.Dispose()",
          ]
        : ["sh", "-c", 'exec 9<"$ORC_TEST_LOCK"; flock -x 9; echo ready; read release'];
    const child = Bun.spawn(command, {
      env: { ...process.env, ORC_TEST_LOCK: path },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain("ready");
      reader.releaseLock();
      expect(hasWriter(path)).toBe(true);
    } finally {
      child.stdin.write("release\n");
      child.stdin.end();
      expect(await child.exited).toBe(0);
    }
    expect(hasWriter(path)).toBe(false);
  });
});

describe("lifecycle parity", () => {
  test.each(["claude", "codex", "cursor", "cursor-agent", "gemini"])(
    "should keep %s waiting without activity and stop on exit",
    async (backend) => {
      const registry = join(root, backend);
      const now = Date.now() - 3_600_000;
      const record = {
        backend,
        externalId: "session-one",
        pid: process.pid,
        status: "idle" as const,
        title: "Waiting session",
        createdAt: now,
        updatedAt: now,
      };
      writeRegistration(record, registry);
      const adapter: SessionAdapter = withLifecycle(
        {
          backend,
          minIntervalMs: 0,
          async list() {
            return [];
          },
        },
        registry,
      );
      await runSync([adapter], { force: true });
      const response = await req(app, "GET", `/sessions/live?agent=${backend}`);
      expect((await response.json()).sessions).toMatchObject([
        { session_id: "session-one", status: "idle" },
      ]);
      const task = await (await req(app, "POST", "/tasks", { title: "Agent task" })).json();
      const row = (await (await req(app, "GET", `/sessions/live?agent=${backend}`)).json())
        .sessions[0];
      expect(
        (await req(app, "PATCH", `/sessions/live/${row.id}`, { task_id: task.id })).status,
      ).toBe(200);
      writeRegistration({ ...record, status: "running" }, registry);
      await runSync([adapter], { force: true });
      expect(
        (await (await req(app, "GET", `/sessions/live?agent=${backend}`)).json()).sessions[0],
      ).toMatchObject({ status: "running", task: { id: task.id } });
      writeRegistration({ ...record, pid: 2_000_000_000 }, registry);
      await runSync([adapter], { force: true });
      expect(
        (await (await req(app, "GET", `/sessions/live?agent=${backend}`)).json()).sessions,
      ).toEqual([]);
    },
  );

  test("should discover a newly registered agent without an adapter or server restart", async () => {
    const registry = join(root, "dynamic");
    const stop = startSessionWatcher({
      adapters: [],
      registryDir: null,
      liveRegistryDir: registry,
      tickMs: 100,
    });
    try {
      writeRegistration(
        {
          backend: "custom-agent",
          externalId: "custom-one",
          pid: process.pid,
          title: "Custom agent",
          status: "idle",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        registry,
      );
      let sessions: { session_id: string }[] = [];
      for (let i = 0; i < 20 && !sessions.length; i++) {
        await Bun.sleep(50);
        sessions = (await (await req(app, "GET", "/sessions/live?agent=custom-agent")).json())
          .sessions;
      }
      expect(sessions).toMatchObject([{ session_id: "custom-one" }]);
    } finally {
      stop();
    }
  });

  test("should reject registry identities that escape the directory", () => {
    expect(() =>
      writeRegistration(
        {
          backend: "gemini",
          externalId: "../escape",
          pid: process.pid,
          title: "bad",
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
        root,
      ),
    ).toThrow();
  });
});

test("should use ownership and turn state for Codex independently of stale file times", async () => {
  const home = join(root, "codex");
  mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
  const rollout = join(home, "rollout.jsonl");
  writeFileSync(rollout, "");
  utimesSync(rollout, 1, 1);
  const path = join(home, "state_5.sqlite");
  const db = new Database(path);
  db.exec(
    "CREATE TABLE threads (id TEXT, title TEXT, name TEXT, cwd TEXT, preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT, created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER, archived INTEGER)",
  );
  db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "native-one",
    "Native",
    null,
    "/tmp",
    "",
    "",
    10,
    rollout,
    1000,
    1,
    1000,
    1,
    0,
  );
  db.close();
  const history = new Database(join(home, "thread_history_1.sqlite"));
  history.exec("CREATE TABLE thread_turns (thread_id TEXT, status TEXT, rollout_ordinal INTEGER)");
  history.exec("INSERT INTO thread_turns VALUES ('native-one', 'inProgress', 1)");
  let owned = true;
  const adapter = codexAdapter(path, { writer: () => owned });
  expect((await adapter.list(new Map()))[0]?.status).toBe("running");
  history.exec("INSERT INTO thread_turns VALUES ('native-one', 'completed', 2)");
  expect((await adapter.list(new Map()))[0]?.status).toBe("idle");
  owned = false;
  expect((await adapter.list(new Map()))[0]?.status).toBe("stopped");
  history.close();
});

test("should discover Cursor CLI chat metadata", async () => {
  const rootPath = join(root, "cursor-cli", "workspace", "chat-one");
  mkdirSync(rootPath, { recursive: true });
  writeFileSync(
    join(rootPath, "meta.json"),
    JSON.stringify({ title: "CLI chat", cwd: root, createdAtMs: 1000, updatedAtMs: 2000 }),
  );
  expect(await cursorAgentAdapter(join(root, "cursor-cli")).list(new Map())).toMatchObject([
    { backend: "cursor-agent", externalId: "chat-one", title: "CLI chat", cwd: root },
  ]);
});

test("should discover and read Gemini native conversations and tool results", async () => {
  const directory = join(root, "gemini", "hash", "chats");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "session-one.json");
  writeFileSync(
    path,
    JSON.stringify({
      sessionId: "gemini-one",
      startTime: "2026-10-01T00:00:00Z",
      lastUpdated: "2026-10-01T00:01:00Z",
      directories: [root],
      messages: [
        { type: "user", content: [{ text: "Fix the build" }] },
        {
          type: "gemini",
          content: "Fixed",
          tokens: { total: 30 },
          toolCalls: [
            {
              id: "tool-one",
              name: "read_file",
              args: { path: "file.ts" },
              result: [{ text: "file contents" }],
            },
          ],
        },
      ],
    }),
  );
  expect(await geminiAdapter(join(root, "gemini")).list(new Map())).toMatchObject([
    {
      backend: "gemini",
      externalId: "gemini-one",
      tokensUsed: 30,
      title: "Fix the build",
      cwd: root,
    },
  ]);
  const transcript = await readTranscript(path, "gemini");
  expect(transcript.total).toBe(2);
  expect(transcript.turns[1]?.blocks[1]).toMatchObject({
    type: "tool_use",
    name: "read_file",
    result: "file contents",
  });
});
