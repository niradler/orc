import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSqlite } from "@orc/db/client";
import type { createApp } from "../server.js";
import { runSync } from "../session-watcher.js";
import { claudeAdapter } from "../sessions/claude.js";
import { codexAdapter } from "../sessions/codex.js";
import { cursorAdapter } from "../sessions/cursor.js";
import { opencodeAdapter } from "../sessions/opencode.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

type Row = {
  id: string;
  agent: string;
  session_id: string;
  parent_id: string | null;
  name: string;
  status: string;
  last_activity_at: string | null;
  created_at: string;
};

let app: ReturnType<typeof createApp>;
const root = mkdtempSync(join(tmpdir(), "orc-session-children-"));
const DEAD_PID = 2_000_000_000;

async function live(query = "") {
  const res = await req(app, "GET", `/sessions/live?active=false&limit=1000${query}`);
  expect(res.status).toBe(200);
  return (await res.json()).sessions as Row[];
}

const jsonl = (lines: object[]) => lines.map((line) => JSON.stringify(line)).join("\n");

beforeAll(() => {
  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
  rmSync(root, { recursive: true, force: true });
});

describe("claude sessions after /clear", () => {
  const registry = join(root, "claude-registry");
  const projects = join(root, "claude-projects", "-tmp-orc");
  const first = "aaaaaaaa-0000-4000-8000-000000000001";
  const cleared = "aaaaaaaa-0000-4000-8000-000000000002";

  test("each conversation keeps its own title, start and last message time", async () => {
    mkdirSync(registry, { recursive: true });
    mkdirSync(join(projects, first, "subagents"), { recursive: true });
    const register = (sessionId: string) =>
      writeFileSync(
        join(registry, "21355.json"),
        JSON.stringify({
          pid: DEAD_PID,
          sessionId,
          cwd: "/tmp/orc",
          name: "orc-70",
          nameSource: "derived",
          startedAt: Date.parse("2026-11-12T12:09:49Z"),
          updatedAt: Date.parse("2026-11-12T12:09:49Z"),
        }),
      );
    writeFileSync(
      join(projects, `${first}.jsonl`),
      `${jsonl([
        {
          type: "user",
          timestamp: "2026-11-12T12:10:00Z",
          message: { content: "remove the fullscreen button" },
        },
        { type: "ai-title", aiTitle: "Remove fullscreen button from chat page" },
        { type: "assistant", timestamp: "2026-11-12T18:31:37Z", message: { id: "m1" } },
        { type: "cost-state", totalCostUSD: 0.86 },
      ])}\n`,
    );
    const cleanup = new Date("2026-11-13T14:45:41Z");
    utimesSync(join(projects, `${first}.jsonl`), cleanup, cleanup);
    writeFileSync(
      join(projects, `${cleared}.jsonl`),
      jsonl([
        {
          type: "user",
          timestamp: "2026-11-13T14:45:41Z",
          message: { content: "<command-name>/clear</command-name>" },
        },
        {
          type: "user",
          timestamp: "2026-11-13T14:46:00Z",
          message: { content: "build the last master dmg" },
        },
      ]),
    );
    writeFileSync(
      join(projects, first, "subagents", "agent-a1b2c3.jsonl"),
      jsonl([{ type: "user", isSidechain: true, timestamp: "2026-11-12T12:11:00Z" }]),
    );
    writeFileSync(
      join(projects, first, "subagents", "agent-a1b2c3.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "Find the fullscreen button" }),
    );
    const adapter = claudeAdapter({
      registry,
      desktop: null,
      projects: join(root, "claude-projects"),
    });
    register(first);
    await runSync([adapter], { force: true });
    register(cleared);
    await runSync([adapter], { force: true });
    await runSync([adapter], { force: true });

    const rows = await live("&agent=claude");
    const byNative = new Map(rows.map((row) => [row.session_id, row]));
    expect(byNative.get(cleared)).toMatchObject({
      name: "build the last master dmg",
      created_at: "2026-11-13T14:45:41.000Z",
    });
    expect(byNative.get(first)?.name).toBe("Remove fullscreen button from chat page");
    expect(byNative.get(first)?.last_activity_at).toBe("2026-11-12T18:31:37.000Z");
    expect(rows.some((row) => row.name === "orc-70")).toBe(false);
    expect(byNative.has("agent-a1b2c3")).toBe(false);

    const nested = await live("&agent=claude&include_children=true");
    const child = nested.find((row) => row.session_id === "agent-a1b2c3");
    expect(child).toMatchObject({
      name: "Find the fullscreen button",
      parent_id: byNative.get(first)?.id,
      status: "stopped",
    });
  });
});

test("a session that never wrote a transcript drops its process name", async () => {
  const id = "aaaaaaaa-0000-4000-8000-000000000003";
  const records = await claudeAdapter({
    registry: join(root, "no-registry"),
    desktop: null,
    projects: join(root, "no-projects"),
  }).list(
    new Map([
      [
        id,
        {
          lastActivityMs: 1_790_000_000_000,
          tokensUsed: null,
          session: {
            backend: "claude",
            externalId: id,
            title: "orc-e5",
            cwd: "/tmp/orc",
            status: "stopped",
            createdAt: new Date(1_790_000_000_000),
            lastActivityAt: new Date(1_790_000_000_000),
          },
        },
      ],
    ]),
  );
  expect(records.find((record) => record.externalId === id)?.title).toBe("New session");
});

test("a twin row for the same native session is listed once, the freshest copy", async () => {
  const insert = getSqlite().prepare(
    "INSERT INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, title, status, last_activity_at, updated_at, created_at) VALUES (?, '__live-sessions__', 'claude', 'direct', 'twin-native', ?, 'stopped', 1790000000, ?, 1790000000)",
  );
  insert.run("twinold", "nir-2c", 1_790_000_000);
  insert.run("twinnew", "Counting from 1 to 60", 1_790_000_500);
  const rows = (await live("&agent=claude")).filter((row) => row.session_id === "twin-native");
  expect(rows.map((row) => row.name)).toEqual(["Counting from 1 to 60"]);
});

test("a chat thread named after the Claude process shows its session's real title", async () => {
  const sqlite = getSqlite();
  sqlite
    .prepare(
      "INSERT INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, title, cwd, status, created_at) VALUES ('srcrow', '__live-sessions__', 'claude', 'direct', 'native-src', 'Plan the release', '/tmp/orc', 'stopped', 1790000000)",
    )
    .run();
  const thread = sqlite.prepare(
    "INSERT INTO chat_threads (id, title, updated_at, data) VALUES (?, ?, 1, ?)",
  );
  thread.run(
    "90000000-0000-4000-8000-0000000000a1",
    "orc-e5",
    JSON.stringify({ sourceId: "srcrow" }),
  );
  thread.run(
    "90000000-0000-4000-8000-0000000000a2",
    "My own chat name",
    JSON.stringify({ sourceId: "srcrow" }),
  );
  const res = await req(app, "GET", "/chat/threads");
  const titles = new Map(
    ((await res.json()).threads as { id: string; title: string }[]).map((row) => [
      row.id,
      row.title,
    ]),
  );
  expect(titles.get("90000000-0000-4000-8000-0000000000a1")).toBe("Plan the release");
  expect(titles.get("90000000-0000-4000-8000-0000000000a2")).toBe("My own chat name");
});

describe("codex subagents", () => {
  test("a spawned thread links to its parent and a database without a source column still lists", async () => {
    const dir = join(root, "codex");
    mkdirSync(dir, { recursive: true });
    const columns =
      "id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT, created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER, archived INTEGER";
    const withSource = new Database(join(dir, "state.sqlite"));
    withSource.exec(`CREATE TABLE threads (${columns}, source TEXT)`);
    withSource
      .prepare(
        "INSERT INTO threads (id, title, cwd, preview, first_user_message, tokens_used, rollout_path, created_at_ms, created_at, updated_at_ms, updated_at, source, archived) VALUES (?,?,?,?,?,0,'/missing.jsonl',1790000000000,1790000000,1790000100000,1790000100,?,0)",
      )
      .run("019e-parent", "Review the PR", "/tmp/codex", "", "Review the PR", "cli");
    withSource
      .prepare(
        "INSERT INTO threads (id, title, cwd, preview, first_user_message, tokens_used, rollout_path, created_at_ms, created_at, updated_at_ms, updated_at, source, archived) VALUES (?,?,?,?,?,0,'/missing.jsonl',1790000000000,1790000000,1790000100000,1790000100,?,0)",
      )
      .run(
        "019e-child",
        "READ-ONLY adversarial code review",
        "/tmp/codex",
        "",
        "READ-ONLY adversarial code review",
        JSON.stringify({
          subagent: {
            thread_spawn: { parent_thread_id: "019e-parent", depth: 1, agent_nickname: "Curie" },
          },
        }),
      );
    withSource.close();
    const legacy = new Database(join(dir, "legacy.sqlite"));
    legacy.exec(`CREATE TABLE threads (${columns})`);
    legacy
      .prepare(
        "INSERT INTO threads (id, title, cwd, preview, first_user_message, tokens_used, rollout_path, created_at_ms, created_at, updated_at_ms, updated_at, archived) VALUES (?,?,?,?,?,0,'/missing.jsonl',1790000000000,1790000000,1790000100000,1790000100,0)",
      )
      .run("019e-legacy", "Old thread", "/tmp/codex", "", "Old thread");
    legacy.close();

    const records = await codexAdapter(join(dir, "state.sqlite"), {
      dbPaths: [join(dir, "state.sqlite"), join(dir, "legacy.sqlite")],
    }).list(new Map());
    const byId = new Map(records.map((record) => [record.externalId, record]));
    expect(byId.get("019e-child")?.parentId).toBe("019e-parent");
    expect(byId.get("019e-parent")?.parentId).toBeUndefined();
    expect(byId.has("019e-legacy")).toBe(true);
  });
});

describe("cursor subagents and folders", () => {
  test("a subagent composer links to its parent and takes the workspace folder", async () => {
    const user = join(root, "cursor", "User");
    const global = join(user, "globalStorage");
    const workspace = join(user, "workspaceStorage", "ws1");
    mkdirSync(global, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const state = new Database(join(global, "state.vscdb"));
    state.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const put = state.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
    put.run(
      "composerData:parent-1",
      JSON.stringify({ name: "Plan the feature", createdAt: 1_790_000_000_000 }),
    );
    put.run(
      "composerData:child-1",
      JSON.stringify({
        name: "Explore the repo",
        createdAt: 1_790_000_001_000,
        subagentInfo: { parentComposerId: "parent-1", subagentTypeName: "explore" },
      }),
    );
    state.close();
    writeFileSync(
      join(workspace, "workspace.json"),
      JSON.stringify({ folder: "file:///tmp/cursor%20repo" }),
    );
    const ws = new Database(join(workspace, "state.vscdb"));
    ws.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    ws.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
      "composer.composerData",
      JSON.stringify({ allComposers: [{ composerId: "parent-1" }] }),
    );
    ws.close();

    const records = await cursorAdapter({
      projects: null,
      stateDb: join(global, "state.vscdb"),
    }).list(new Map());
    const byId = new Map(records.map((record) => [record.externalId, record]));
    expect(byId.get("parent-1")).toMatchObject({ cwd: "/tmp/cursor repo" });
    expect(byId.get("parent-1")?.parentId).toBeUndefined();
    expect(byId.get("child-1")).toMatchObject({ parentId: "parent-1", cwd: "/tmp/cursor repo" });
  });
});

describe("opencode subagents", () => {
  test("child sessions are listed with their parent", async () => {
    const path = join(root, "opencode.db");
    const db = new Database(path);
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER)",
    );
    const insert = db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,0,0,0)");
    insert.run("ses_parent01", null, "/tmp/oc", "Fix the build", 1_000, 2_000);
    insert.run("ses_child001", "ses_parent01", "/tmp/oc", "General subagent", 1_500, 1_800);
    insert.run("ses_orphan01", "ses_missing1", "/tmp/oc", "Orphan", 1_500, 1_800);
    db.close();

    const records = await opencodeAdapter(path).list(new Map());
    const byId = new Map(records.map((record) => [record.externalId, record]));
    expect(byId.get("ses_child001")?.parentId).toBe("ses_parent01");
    expect(byId.get("ses_parent01")?.parentId).toBeUndefined();
    expect(byId.has("ses_orphan01")).toBe(false);
  });
});
