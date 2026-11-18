import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ChatThread } from "@orc/core/chat";
import { resetConfig } from "@orc/core/config";
import { SessionHandoffSchema } from "@orc/core/session-handoff";
import type { SessionSend, SessionSendPreview } from "@orc/core/session-send";
import { getDb } from "@orc/db/client";
import { bridge_chats, gateway_sessions, session_sends } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { consumeHandoffBriefing } from "../routes/chat.js";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "orc-send-to-"));
const remote = join(root, "remote.git");
const source = join(root, "source");
const target = join(root, "target");
const sourceClaude = join(root, "source-claude");
const destHome = join(root, "dest-home");
const destClaude = join(root, "dest-claude");
const bin = join(root, "bin");
const originalPath = process.env.PATH;
const sourceNativeId = randomUUID();
const liveId = "sendlive1";
let app: ReturnType<typeof createApp>;
let destination: ReturnType<typeof Bun.spawn> | null = null;
let destUrl = "";
let headCommit = "";

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

function claudeRows(sessionId: string, cwd: string) {
  const timestamp = new Date().toISOString();
  const messageId = randomUUID();
  return [
    {
      type: "user",
      sessionId,
      cwd,
      uuid: messageId,
      parentUuid: null,
      isSidechain: false,
      timestamp,
      message: { role: "user", content: "Continue the parser work" },
    },
    {
      type: "assistant",
      sessionId,
      cwd,
      uuid: randomUUID(),
      parentUuid: messageId,
      isSidechain: false,
      timestamp,
      message: {
        id: "msg_send",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Parser tests are next" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
}

function writeTranscript(sessionId: string, cwd: string): string {
  const key = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(sourceClaude, "projects", key);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(
    file,
    `${claudeRows(sessionId, cwd)
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
  );
  return file;
}

function createOpenCodeDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, workspace_id TEXT,
      slug TEXT, directory TEXT, path TEXT, title TEXT, version TEXT,
      agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE IF NOT EXISTS session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_v2(id),
      type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL
    );
  `);
  db.close();
}

function seedOpenCodeSession(path: string, sessionId: string, cwd: string): void {
  const db = new Database(path);
  const now = Date.now();
  db.query(
    "INSERT INTO session_v2 (id, project_id, directory, path, title, version, agent, model, time_created, time_updated) VALUES (?, 'global', ?, ?, 'OpenCode send fixture', '1.19.5', 'build', ?, ?, ?)",
  ).run(
    sessionId,
    cwd,
    cwd.replace(/\\/g, "/"),
    JSON.stringify({ id: "test-model", providerID: "test" }),
    now,
    now,
  );
  db.query(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "msg_fixture_user",
    sessionId,
    "user",
    0,
    now,
    now,
    JSON.stringify({ text: "Continue the OpenCode move", time: { created: now } }),
  );
  db.query(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "msg_fixture_assistant",
    sessionId,
    "assistant",
    1,
    now,
    now,
    JSON.stringify({
      content: [{ type: "text", text: "Ready to continue elsewhere" }],
      finish: "stop",
      time: { created: now },
    }),
  );
  db.close();
}

async function insertLiveSession(
  id: string,
  nativeId: string,
  transcriptPath: string,
  backend = "claude",
) {
  const db = getDb();
  await db
    .insert(bridge_chats)
    .values({ id: "__live-sessions__", platform: "telegram", chat_id: "live" })
    .onConflictDoNothing();
  await db.insert(gateway_sessions).values({
    id,
    chat_id: "__live-sessions__",
    backend,
    mode: "direct",
    runtime_session_id: nativeId,
    cwd: source,
    status: "stopped",
    title: "Send fixture",
    summary: "A session to move",
    transcript_path: transcriptPath,
    last_activity_at: new Date(),
  });
}

async function destFetch(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${destUrl}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer dest-secret",
      Connection: "close",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function startDestination(): Promise<void> {
  mkdirSync(destHome, { recursive: true });
  mkdirSync(destClaude, { recursive: true });
  // The destination OpenCode store must exist before a session can be installed.
  const destOpenCodeDir = join(destHome, ".local", "share", "opencode");
  mkdirSync(destOpenCodeDir, { recursive: true });
  createOpenCodeDb(join(destOpenCodeDir, "opencode.db"));
  destination = Bun.spawn(
    [process.execPath, join(import.meta.dirname, "fixtures", "send-destination.ts")],
    {
      env: {
        ...process.env,
        ORC_HOME: destHome,
        ORC_DB_PATH: join(destHome, "orc.db"),
        ORC_API_HOST: "127.0.0.1",
        ORC_API_PORT: "0",
        ORC_API_SECRET: "dest-secret",
        ORC_ACTIVE_PROJECT: "",
        ORC_E2E_CHAT_MOCK: "1",
        CLAUDE_CONFIG_DIR: destClaude,
        HOME: destHome,
        USERPROFILE: destHome,
      },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const stdout = destination.stdout;
  if (!stdout || typeof stdout === "number")
    throw new Error("The destination ORC stdout is not piped");
  const reader = stdout.getReader();
  let buffer = "";
  let port = 0;
  while (!port) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The destination ORC exited before reporting its port");
    buffer += new TextDecoder().decode(value);
    const match = buffer.match(/PORT=(\d+)/);
    if (match) port = Number(match[1]);
  }
  reader.releaseLock();
  destUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const health = await fetch(`${destUrl}/api/health`, { headers: { Connection: "close" } });
      if (health.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("The destination ORC did not become healthy");
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  // The destination's handoff initiation checks the agent CLI; fake binaries keep
  // the test independent of installed agents, like the handoff suite.
  mkdirSync(bin);
  for (const name of ["claude", "codex", "opencode", "pi"]) {
    writeFileSync(
      join(bin, process.platform === "win32" ? `${name}.cmd` : name),
      process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
  }
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
  await git("init", "--bare", remote);
  await git("init", source);
  writeFileSync(join(source, ".gitignore"), "# Worktree exclusions are installed by ORC\n");
  writeFileSync(join(source, ".gitattributes"), "* -text\n");
  writeFileSync(join(source, "work.txt"), "committed state\n");
  await git("-C", source, "add", ".gitignore", ".gitattributes", "work.txt");
  await git(
    "-C",
    source,
    "-c",
    "user.name=ORC Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Initial state",
  );
  headCommit = await git("-C", source, "rev-parse", "HEAD");
  await git("-C", source, "remote", "add", "origin", remote);
  await git("-C", source, "push", "origin", "HEAD:refs/heads/main");
  await git("clone", "--branch", "main", remote, target);
  // Uncommitted, untracked and secret work that the snapshot must carry (or keep local).
  writeFileSync(join(source, "work.txt"), "uncommitted edit\n");
  writeFileSync(join(source, "notes.txt"), "untracked notes\n");
  writeFileSync(join(source, ".env"), "SECRET=stay-local\n");
  app = setupTestApp();
  resetConfig();
  const transcriptPath = writeTranscript(sourceNativeId, source);
  await insertLiveSession(liveId, sourceNativeId, transcriptPath);
  await startDestination();
  const project = await destFetch("POST", "/projects", { name: "send-dest", scope: target });
  expect(project.status).toBe(201);
}, 60_000);

afterAll(async () => {
  if (destination) {
    destination.kill();
    await destination.exited;
  }
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  teardownTestApp();
  // Windows releases child file handles asynchronously; match the shard cleanup budget.
  rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
});

describe("send a session to another ORC installation", () => {
  test("preview reports what would move", async () => {
    const res = await req(app, "GET", `/sessions/live/${liveId}/send-preview`);
    expect(res.status).toBe(200);
    const preview = (await res.json()) as SessionSendPreview;
    expect(preview.eligible).toBe(true);
    expect(preview.agent).toBe("claude");
    expect(preview.repository).toBe(remote);
    expect(preview.subdirectory).toBe("");
    expect(preview.reason).toBeNull();
  });

  test("moves the session and the destination can continue it", async () => {
    const res = await req(app, "POST", `/sessions/live/${liveId}/send-to`, {
      host_label: "Test box",
      url: destUrl,
      token: "dest-secret",
      project: "send-dest",
      note: "finish the parser tests",
    });
    expect(res.status).toBe(200);
    const send = (await res.json()) as SessionSend;
    expect(send.status).toBe("ready");
    expect(send.error).toBeNull();
    expect(send.host_label).toBe("Test box");
    expect(send.left_behind).toEqual([".env"]);
    expect(send.commit).not.toBe(headCommit);
    expect(send.branch).toBe(`orc/send/${send.id}`);
    expect(send.handoff_id).toBeTruthy();
    expect(send.remote_session_id).toBeTruthy();

    // The source checkout keeps its index, HEAD and dirty worktree untouched.
    expect(await git("-C", source, "rev-parse", "HEAD")).toBe(headCommit);
    expect(await git("-C", source, "diff", "--cached", "--name-only")).toBe("");
    const status = await git("-C", source, "status", "--porcelain=v1", "--untracked-files=all");
    expect(status).toContain("work.txt");
    expect(status).toContain("notes.txt");
    expect(status).toContain(".env");
    expect(readFileSync(join(source, ".env"), "utf8")).toBe("SECRET=stay-local\n");

    // The destination prepared the exact snapshot without the secret file.
    const handoffRes = await destFetch("GET", `/session-handoffs/${send.handoff_id}`);
    expect(handoffRes.status).toBe(200);
    const handoff = SessionHandoffSchema.parse(await handoffRes.json());
    expect(handoff.status).toBe("ready");
    expect(handoff.live_session_id).toBe(send.remote_session_id);
    const worktree = join(realpathSync(target), ".orc", "worktrees", handoff.id);
    expect(send.commit).toBeTruthy();
    expect(await git("-C", worktree, "rev-parse", "HEAD")).toBe(send.commit ?? "");
    expect(readFileSync(join(worktree, "work.txt"), "utf8")).toBe("uncommitted edit\n");
    expect(readFileSync(join(worktree, "notes.txt"), "utf8")).toBe("untracked notes\n");
    expect(() => readFileSync(join(worktree, ".env"), "utf8")).toThrow();

    // The native transcript was installed under a new id with relocated cwd.
    const key = worktree.replace(/[^a-zA-Z0-9]/g, "-");
    const installed = join(destClaude, "projects", key, `${handoff.session_id}.jsonl`);
    const rows = readFileSync(installed, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { sessionId: string; cwd: string });
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.sessionId).toBe(handoff.session_id);
      expect(row.cwd).toBe(worktree);
    }

    // The moved session is listed as ready to resume on the destination.
    const liveRes = await destFetch("GET", "/sessions/live?limit=500");
    const live = (await liveRes.json()) as {
      sessions: { id: string; handoff: { status: string } | null }[];
    };
    const moved = live.sessions.find((session) => session.id === send.remote_session_id);
    expect(moved?.handoff?.status).toBe("ready");

    // Resuming in chat imports the source history and carries the briefing.
    const resumeRes = await destFetch("POST", "/chat/threads", {
      sourceSessionId: send.remote_session_id,
    });
    expect(resumeRes.status).toBe(200);
    const thread = (await resumeRes.json()) as ChatThread;
    expect(thread.importedMessages ?? 0).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(thread.messages)).toContain("parser");
    expect(thread.handoffBriefing).toContain("[ORC send-to]");
    expect(thread.handoffBriefing).toContain("finish the parser tests");
    expect(thread.handoffBriefing).toContain(".env");

    // The first turn continues the conversation; the briefing is consumed once.
    const turnRes = await destFetch("POST", "/chat/stream", {
      threadId: thread.id,
      messages: [{ role: "user", content: "Reply with exactly: CONTINUED-OK." }],
    });
    expect(turnRes.status).toBe(200);
    expect(await turnRes.text()).toContain("CONTINUED-OK");
    const afterRes = await destFetch("GET", `/chat/threads/${thread.id}`);
    const after = (await afterRes.json()) as ChatThread;
    expect(after.handoffBriefing).toBeUndefined();
    const handoffAfter = SessionHandoffSchema.parse(
      await (await destFetch("GET", `/session-handoffs/${send.handoff_id}`)).json(),
    );
    expect(handoffAfter.status).toBe("resumed");
    const secondTurn = await destFetch("POST", "/chat/stream", {
      threadId: thread.id,
      messages: [{ role: "user", content: "Reply with exactly: AGAIN-OK." }],
    });
    expect(secondTurn.status).toBe(200);
    expect(await secondTurn.text()).toContain("AGAIN-OK");
  }, 60_000);

  test("the source records the move on the session", async () => {
    const res = await req(app, "GET", "/sessions/live?limit=500");
    const body = (await res.json()) as {
      sessions: { id: string; send: { status: string; host_label: string } | null }[];
    };
    const row = body.sessions.find((session) => session.id === liveId);
    expect(row?.send?.status).toBe("ready");
    expect(row?.send?.host_label).toBe("Test box");
    const history = await req(app, "GET", `/sessions/live/${liveId}/sends`);
    const sends = (await history.json()) as { sends: SessionSend[] };
    expect(sends.sends.length).toBe(1);
    expect(sends.sends[0]?.remote_session_id).toBeTruthy();
  });

  test("a destination without the project records a clear error", async () => {
    const nativeId = randomUUID();
    const transcriptPath = writeTranscript(nativeId, source);
    await insertLiveSession("sendlive2", nativeId, transcriptPath);
    const res = await req(app, "POST", "/sessions/live/sendlive2/send-to", {
      host_label: "Test box",
      url: destUrl,
      token: "dest-secret",
      project: "does-not-exist",
    });
    expect(res.status).toBe(200);
    const send = (await res.json()) as SessionSend;
    expect(send.status).toBe("error");
    expect(send.error).toContain("Project");
    expect(send.remote_session_id).toBeNull();
  });

  test("unsupported backends and unreachable hosts are refused", async () => {
    const nativeId = randomUUID();
    const transcriptPath = writeTranscript(nativeId, source);
    await insertLiveSession("sendlive3", nativeId, transcriptPath, "gemini");
    const preview = await req(app, "GET", "/sessions/live/sendlive3/send-preview");
    const body = (await preview.json()) as SessionSendPreview;
    expect(body.eligible).toBe(false);
    expect(body.reason).toContain("Claude Code, Codex, OpenCode and Pi");
    const refused = await req(app, "POST", "/sessions/live/sendlive3/send-to", {
      host_label: "Test box",
      url: destUrl,
      token: "dest-secret",
      project: "send-dest",
    });
    expect(refused.status).toBe(400);
    const unreachable = await req(app, "POST", "/sessions/live/sendlive2/send-to", {
      host_label: "Ghost",
      url: "http://127.0.0.1:1",
      project: "send-dest",
    });
    expect(unreachable.status).toBe(200);
    const ghost = (await unreachable.json()) as SessionSend;
    expect(ghost.status).toBe("error");
    expect(ghost.error).toContain("Could not reach");
  });

  test("moves a Pi session and the destination continues it", async () => {
    const nativeId = randomUUID();
    const timestamp = new Date().toISOString();
    const piFile = join(root, `pi-${nativeId}.jsonl`);
    const rows = [
      { type: "session", version: 3, id: nativeId, timestamp, cwd: source },
      {
        type: "message",
        id: "entry-user",
        parentId: null,
        timestamp,
        message: { role: "user", content: "Continue the Pi move" },
      },
      {
        type: "message",
        id: "entry-assistant",
        parentId: "entry-user",
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text: "Pi ready to continue" }] },
      },
    ];
    writeFileSync(piFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await insertLiveSession("sendlivepi", nativeId, piFile, "pi");
    const res = await req(app, "POST", "/sessions/live/sendlivepi/send-to", {
      host_label: "Test box",
      url: destUrl,
      token: "dest-secret",
      project: "send-dest",
    });
    expect(res.status).toBe(200);
    const send = (await res.json()) as SessionSend;
    expect(send.status).toBe("ready");
    const handoff = SessionHandoffSchema.parse(
      await (await destFetch("GET", `/session-handoffs/${send.handoff_id}`)).json(),
    );
    const worktree = join(realpathSync(target), ".orc", "worktrees", handoff.id);
    const key = worktree.replace(/[^a-zA-Z0-9]/g, "-");
    const piDir = join(destHome, ".pi", "agent", "sessions", key);
    const fileName = readdirSync(piDir).find((name) =>
      name.endsWith(`_${handoff.session_id}.jsonl`),
    );
    expect(fileName).toBeTruthy();
    const installed = join(piDir, fileName ?? "");
    const header = JSON.parse(readFileSync(installed, "utf8").split("\n")[0] ?? "{}") as {
      id: string;
      cwd: string;
    };
    expect(header.id).toBe(handoff.session_id);
    expect(header.cwd).toBe(worktree);
    // Pi chat resume requires an enabled Pi provider, like any Pi conversation.
    const current = (await (await destFetch("GET", "/settings/providers")).json()) as {
      revision: string;
    };
    const saved = await destFetch("PUT", "/settings/providers", {
      providers: [
        { id: "pi-test", name: "Pi test", agent: "pi", enabled: true, model: "", environment: [] },
      ],
      default_provider_id: "pi-test",
      revision: current.revision,
    });
    expect(saved.status).toBe(200);
    const resumed = (await (
      await destFetch("POST", "/chat/threads", { sourceSessionId: send.remote_session_id })
    ).json()) as ChatThread;
    expect(resumed.importedMessages ?? 0).toBeGreaterThanOrEqual(2);
    const turn = await destFetch("POST", "/chat/stream", {
      threadId: resumed.id,
      messages: [{ role: "user", content: "Reply with exactly: PI-OK." }],
    });
    expect(await turn.text()).toContain("PI-OK");
  }, 60_000);

  test("moves an OpenCode session into the destination database and continues it", async () => {
    const nativeId = "ses_sendfixture01";
    const sourceDb = join(root, "source-opencode.db");
    createOpenCodeDb(sourceDb);
    seedOpenCodeSession(sourceDb, nativeId, source);
    await insertLiveSession("sendliveoc", nativeId, sourceDb, "opencode");
    const res = await req(app, "POST", "/sessions/live/sendliveoc/send-to", {
      host_label: "Test box",
      url: destUrl,
      token: "dest-secret",
      project: "send-dest",
    });
    expect(res.status).toBe(200);
    const send = (await res.json()) as SessionSend;
    expect(send.status).toBe("ready");
    const handoff = SessionHandoffSchema.parse(
      await (await destFetch("GET", `/session-handoffs/${send.handoff_id}`)).json(),
    );
    const worktree = join(realpathSync(target), ".orc", "worktrees", handoff.id);
    const destDb = new Database(join(destHome, ".local", "share", "opencode", "opencode.db"), {
      readonly: true,
    });
    try {
      const row = destDb
        .query("SELECT directory, title FROM session_v2 WHERE id = ?")
        .get(handoff.session_id) as { directory: string; title: string } | undefined;
      expect(row?.directory).toBe(worktree);
      expect(row?.title).toBe("OpenCode send fixture");
      const messages = destDb
        .query("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq")
        .all(handoff.session_id) as { type: string; data: string }[];
      expect(messages.length).toBe(2);
      expect(messages[0]?.type).toBe("user");
      expect(messages[0]?.data).toContain("Continue the OpenCode move");
      expect(messages[1]?.data).toContain("Ready to continue elsewhere");
      const project = destDb.query("SELECT worktree FROM project WHERE id = 'global'").get() as
        | { worktree: string }
        | undefined;
      expect(project?.worktree).toBe(worktree);
      expect(handoff.session_id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    } finally {
      destDb.close();
    }
    const resumed = (await (
      await destFetch("POST", "/chat/threads", { sourceSessionId: send.remote_session_id })
    ).json()) as ChatThread;
    expect(resumed.importedMessages ?? 0).toBeGreaterThanOrEqual(2);
    const turn = await destFetch("POST", "/chat/stream", {
      threadId: resumed.id,
      messages: [{ role: "user", content: "Reply with exactly: OPENCODE-OK." }],
    });
    expect(await turn.text()).toContain("OPENCODE-OK");
  }, 60_000);

  test("credentials are never stored on the source", async () => {
    const rows = await getDb().query.session_sends.findMany({
      where: eq(session_sends.live_session_id, liveId),
    });
    expect(rows.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("dest-secret");
  });
});

describe("consumeHandoffBriefing", () => {
  const base = { id: randomUUID() } as ChatThread;
  test("delivers the briefing once and keeps it for /compact", () => {
    const thread = { ...base, handoffBriefing: "moved" } as ChatThread;
    expect(consumeHandoffBriefing(thread, "/compact", undefined)).toBeUndefined();
    expect(thread.handoffBriefing).toBe("moved");
    expect(consumeHandoffBriefing(thread, "continue", undefined)).toBe("moved");
    expect(thread.handoffBriefing).toBeUndefined();
    expect(consumeHandoffBriefing(thread, "again", "prior")).toBe("prior");
    const combined = { ...base, handoffBriefing: "moved" } as ChatThread;
    expect(consumeHandoffBriefing(combined, "continue", "prior")).toBe("moved\n\nprior");
  });
});
