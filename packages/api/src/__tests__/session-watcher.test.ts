import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostRuntime, LOCAL_HOST, SshError } from "@orc/core/exec-host";
import { CLAUDE_TOKENS_VERSION, USAGE_EVENT_VERSION } from "@orc/core/usage";
import { getSqlite } from "@orc/db/client";
import type { createApp } from "../server.js";
import { runSync, startSessionWatcher, tokensSettled } from "../session-watcher.js";
import { claudeAdapter, registryRecord } from "../sessions/claude.js";
import { codexAdapter } from "../sessions/codex.js";
import { cursorAdapter, cursorStateDbPath, resolveSlugPath } from "../sessions/cursor.js";
import type { SessionAdapter } from "../sessions/types.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

type Row = {
  id: string;
  agent: string;
  session_id: string;
  status: string;
  name: string;
  summary: string | null;
  cwd: string | null;
  tokens_used: number | null;
  tokens_estimated: boolean;
  task: { id: string } | null;
  parent_id: string | null;
  spawned_from_id: string | null;
};

let app: ReturnType<typeof createApp>;
const root = mkdtempSync(join(tmpdir(), "orc-sessions-"));
const registry = join(root, "registry");
mkdirSync(registry);
const SESSION_ID = "33583f12-72b3-4edf-a18d-8616b7d10723";
const DEAD_PID = 2_000_000_000;
const claude = () => claudeAdapter({ registry, desktop: null, projects: null });

function writeEntry(pid: number, sessionId: string, status: string) {
  writeFileSync(
    join(registry, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd: "/tmp/some-repo",
      name: "my session",
      status,
      startedAt: 1_790_000_000_000,
      updatedAt: 1_790_000_100_000,
    }),
  );
}

const storedStatus = (sessionId: string) =>
  getSqlite()
    .query<{ status: string }, [string]>(
      "SELECT status FROM gateway_sessions WHERE runtime_session_id = ?",
    )
    .get(sessionId)?.status;

async function live(opts: { active?: boolean; agent?: string } = {}) {
  const q = `active=${opts.active ?? true}${opts.agent ? `&agent=${opts.agent}` : ""}&limit=1000`;
  const res = await req(app, "GET", `/sessions/live?${q}`);
  expect(res.status).toBe(200);
  return (await res.json()).sessions as Row[];
}

beforeAll(() => {
  app = setupTestApp();
});

afterAll(async () => {
  teardownTestApp();
  // Windows keeps a just-closed fs.watch handle on the directory for a moment.
  // Bun ignores rmSync's retry options, so retry the busy ones ourselves. The
  // loop alone allows 5s, so the hook budget must cover it plus teardown.
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt >= 50) throw error;
      await Bun.sleep(100);
    }
  }
}, 15_000);

describe("claude adapter: live registry", () => {
  test("a busy registry file becomes a running session", async () => {
    writeEntry(process.pid, SESSION_ID, "busy");
    await runSync([claude()], { force: true });
    const rows = await live();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "claude",
      session_id: SESSION_ID,
      status: "running",
      name: "my session",
      cwd: "/tmp/some-repo",
    });
  });

  test("status flips to idle on the same row", async () => {
    writeEntry(process.pid, SESSION_ID, "idle");
    await runSync([claude()], { force: true });
    const rows = await live();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("idle");
  });

  test("a registry file whose pid is dead is stopped, not active", async () => {
    writeEntry(DEAD_PID, "dead-session", "busy");
    await runSync([claude()], { force: true });
    expect((await live()).map((r) => r.session_id)).toEqual([SESSION_ID]);
    expect(storedStatus("dead-session")).toBe("stopped");
    unlinkSync(join(registry, `${DEAD_PID}.json`));
  });

  test("links a task and unlinks it", async () => {
    const task = await (await req(app, "POST", "/tasks", { title: "link me" })).json();
    const [row] = await live();
    const linked = await req(app, "PATCH", `/sessions/live/${row?.id}`, {
      task_id: task.id,
    });
    expect(linked.status).toBe(200);
    expect((await linked.json()).task).toMatchObject({
      id: task.id,
      title: "link me",
    });
    await runSync([claude()], { force: true });
    expect((await live())[0]?.task?.id).toBe(task.id);
    const byTask = await (
      await req(app, "GET", `/sessions/live?task_id=${task.id}&active=false`)
    ).json();
    expect(byTask.sessions.map((r: { id: string }) => r.id)).toEqual([row?.id]);
    const other = await (await req(app, "GET", "/sessions/live?task_id=nope&active=false")).json();
    expect(other.sessions).toEqual([]);
    const cleared = await req(app, "PATCH", `/sessions/live/${row?.id}`, {
      task_id: null,
    });
    expect((await cleared.json()).task).toBeNull();
  });

  test("rejects an unknown task and an unknown session", async () => {
    const [row] = await live();
    expect(
      (
        await req(app, "PATCH", `/sessions/live/${row?.id}`, {
          task_id: "nope",
        })
      ).status,
    ).toBe(404);
    expect((await req(app, "PATCH", "/sessions/live/nope", { task_id: null })).status).toBe(404);
  });

  test("removing the registry file stops the session", async () => {
    unlinkSync(join(registry, `${process.pid}.json`));
    await runSync([claude()], { force: true });
    expect(await live()).toHaveLength(0);
    expect(storedStatus(SESSION_ID)).toBe("stopped");
  });

  test("the fs watcher picks up a new file without a periodic sync", async () => {
    const stop = startSessionWatcher({
      adapters: [claude()],
      registryDir: registry,
    });
    await Bun.sleep(300);
    writeEntry(process.pid, "watched-session", "busy");
    let rows = await live();
    for (let i = 0; i < 30 && rows.length === 0; i++) {
      await Bun.sleep(100);
      rows = await live();
    }
    stop();
    expect(rows.map((r) => r.session_id)).toEqual(["watched-session"]);
    expect(rows[0]?.status).toBe("running");
  });

  test("POST /sessions/live/sync re-imports through the current adapters", async () => {
    const res = await req(app, "POST", "/sessions/live/sync");
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results[0]).toMatchObject({ backend: "claude" });
    expect(results[0].error).toBeUndefined();
  });
});

describe("claude adapter: ended sessions, tokens and summary", () => {
  test("desktop start_session links nest a spawned session under the session that started it", async () => {
    const desktop = join(root, "desktop-spawn", "org", "user");
    mkdirSync(desktop, { recursive: true });
    const write = (desktopId: string, cliId: string, extra: Record<string, unknown> = {}) =>
      writeFileSync(
        join(desktop, `${desktopId}.json`),
        JSON.stringify({
          sessionId: desktopId,
          cliSessionId: cliId,
          cwd: "/tmp/spawn-repo",
          title: cliId,
          createdAt: 1_780_000_000_000,
          lastActivityAt: 1_780_000_500_000,
          ...extra,
        }),
      );
    write("local_root", "spawn-root");
    write("local_child", "spawn-child", { spawnedFrom: { sessionId: "local_root", taskId: "t" } });
    write("local_grand", "spawn-grand", { spawnedFrom: { sessionId: "local_child" } });
    write("local_gone", "spawn-orphan", { spawnedFrom: { sessionId: "local_missing" } });
    write("local_bad", "spawn-bad", { spawnedFrom: "not an object" });
    const transcripts = join(root, "desktop-spawn-projects", "-tmp-spawn-repo");
    mkdirSync(transcripts, { recursive: true });
    for (const cliId of ["spawn-root", "spawn-child", "spawn-grand", "spawn-orphan", "spawn-bad"])
      writeFileSync(
        join(transcripts, `${cliId}.jsonl`),
        `${JSON.stringify({ type: "user", message: { content: cliId } })}\n`,
      );

    await runSync(
      [
        claudeAdapter({
          registry: join(root, "empty-registry"),
          desktop: join(root, "desktop-spawn"),
          projects: join(root, "desktop-spawn-projects"),
        }),
      ],
      { force: true },
    );

    const all = await live({ active: false });
    const idOf = (cliId: string) => all.find((r) => r.session_id === cliId)?.id;
    const spawnedFrom = (cliId: string) => all.find((r) => r.session_id === cliId)?.spawned_from_id;
    expect(idOf("spawn-root")).toBeDefined();
    expect(spawnedFrom("spawn-root")).toBeNull();
    expect(spawnedFrom("spawn-child")).toBe(idOf("spawn-root"));
    expect(spawnedFrom("spawn-grand")).toBe(idOf("spawn-child"));
    expect(spawnedFrom("spawn-orphan")).toBeNull();
    expect(spawnedFrom("spawn-bad")).toBeNull();
    expect(all.find((r) => r.session_id === "spawn-child")?.parent_id).toBeNull();
  });

  test("desktop metadata becomes an ended session with summary and de-duplicated tokens", async () => {
    const desktop = join(root, "desktop", "org", "user");
    const projects = join(root, "projects", "-tmp-ended-repo");
    mkdirSync(desktop, { recursive: true });
    mkdirSync(projects, { recursive: true });
    const id = "11111111-aaaa-bbbb-cccc-000000000001";
    writeFileSync(
      join(desktop, "local_one.json"),
      JSON.stringify({
        cliSessionId: id,
        cwd: "/tmp/ended-repo",
        title: "an old session",
        createdAt: 1_780_000_000_000,
        lastActivityAt: 1_780_000_500_000,
      }),
    );
    writeFileSync(
      join(desktop, "local_archived.json"),
      JSON.stringify({
        cliSessionId: "archived-one",
        cwd: "/tmp/x",
        isArchived: true,
      }),
    );
    const usage = (input: number, output: number, cache: number) => ({
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: cache,
      cache_read_input_tokens: 999_999,
    });
    const lines = [
      {
        type: "user",
        message: { content: "<system-reminder>ignore me</system-reminder>" },
      },
      {
        type: "user",
        message: {
          content: [{ type: "text", text: "fix the flaky test please" }],
        },
      },
      { type: "assistant", message: { id: "m1", usage: usage(10, 20, 30) } },
      { type: "assistant", message: { id: "m1", usage: usage(10, 20, 30) } },
      { type: "assistant", message: { id: "m2", usage: usage(1, 2, 3) } },
    ];
    writeFileSync(join(projects, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));

    const adapter = claudeAdapter({
      registry: join(root, "empty-registry"),
      desktop: join(root, "desktop"),
      projects: join(root, "projects"),
    });
    await runSync([adapter], { force: true });
    await tokensSettled();

    const all = await live({ active: false });
    const row = all.find((r) => r.session_id === id);
    if (!row) throw new Error("Imported session is missing");
    expect(row).toMatchObject({
      agent: "claude",
      status: "stopped",
      name: "an old session",
      cwd: "/tmp/ended-repo",
      summary: "fix the flaky test please",
      tokens_used: 2_000_064,
      tokens_estimated: false,
    });
    expect(all.some((r) => r.session_id === "archived-one")).toBe(false);
    expect((await live()).some((r) => r.session_id === id)).toBe(false);
    const sqlite = getSqlite();
    expect(
      sqlite
        .query<{ tokens_version: number }, [string]>(
          "SELECT tokens_version FROM gateway_sessions WHERE id = ?",
        )
        .get(row.id)?.tokens_version,
    ).toBe(CLAUDE_TOKENS_VERSION);
    sqlite.run("UPDATE gateway_sessions SET tokens_used = 66, tokens_version = 0 WHERE id = ?", [
      row.id,
    ]);
    await runSync([adapter], { force: true });
    await tokensSettled();
    expect(
      (await live({ active: false })).find((session) => session.id === row.id)?.tokens_used,
    ).toBe(2_000_064);
    expect(
      sqlite
        .query<{ tokens_version: number }, [string]>(
          "SELECT tokens_version FROM gateway_sessions WHERE id = ?",
        )
        .get(row.id)?.tokens_version,
    ).toBe(CLAUDE_TOKENS_VERSION);
    const fresh = await adapter.list(
      new Map([
        [
          id,
          {
            lastActivityMs: Date.now(),
            tokensUsed: 2_000_064,
            tokensVersion: CLAUDE_TOKENS_VERSION,
          },
        ],
      ]),
    );
    expect(fresh.find((session) => session.externalId === id)?.tokens).toBeUndefined();
    sqlite.run("UPDATE gateway_sessions SET tokens_used = 66, tokens_version = 0 WHERE id = ?", [
      row.id,
    ]);
    await runSync(
      [
        claudeAdapter({
          registry: join(root, "empty-registry"),
          desktop: null,
          projects: join(root, "projects"),
        }),
      ],
      { force: true },
    );
    await tokensSettled();
    expect((await live({ active: false })).find((session) => session.id === row.id)).toMatchObject({
      tokens_used: 2_000_064,
      name: "an old session",
      status: "stopped",
    });
  });
});

describe("codex adapter", () => {
  test("should use readable cross-platform cwd fallbacks without changing named titles or cwd", async () => {
    const dbPath = join(root, "codex-titles.sqlite");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT,
      preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT,
      created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER,
      archived INTEGER)`);
    const ins = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const cwd = "\\\\?\\C:\\Projects\\orc";
    const cases = [
      ["empty", "", null, "", "orc"],
      ["native-path", cwd, null, "", "orc"],
      ["prompt", "C:/Projects/orc", null, "Fix the notifications", "Fix the notifications"],
      ["named", cwd, "Keep this title", "First prompt", "Keep this title"],
    ] as const;
    try {
      for (const [id, title, name, prompt] of cases)
        ins.run(id, title, name, cwd, "", prompt, 0, "/nope", 1, 1, 1, 1, 0);
    } finally {
      ins.finalize();
      db.close();
    }
    const rows = await codexAdapter(dbPath, { writer: () => false }).list(new Map());
    for (const [id, , , , expected] of cases)
      expect(rows.find((row) => row.externalId === id)).toMatchObject({ title: expected, cwd });
    expect(registryRecord({ pid: DEAD_PID, sessionId: "foreign-path", cwd })).toMatchObject({
      title: "orc",
      cwd,
    });
    expect(
      registryRecord({ pid: DEAD_PID, sessionId: "posix-path", cwd: "/home/nir/orc/" }).title,
    ).toBe("orc");
  });
  test("reads threads with exact tokens and a summary, skipping archived", async () => {
    const dbPath = join(root, "codex-state.sqlite");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT,
      preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT,
      created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER,
      archived INTEGER)`);
    const ins = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const rollout = join(root, "codex-state-rollout.jsonl");
    writeFileSync(rollout, "");
    utimesSync(rollout, 1_790_000_900, 1_790_000_900);
    ins.run(
      "cx-1",
      "Review the diff",
      null,
      "/tmp/cx",
      "review preview text",
      "first msg",
      2540869,
      rollout,
      1_790_000_000_000,
      1_790_000_000,
      1_790_000_900_000,
      1_790_000_900,
      0,
    );
    ins.run("cx-2", "archived", null, "/tmp/cx", "", "", 5, "/nope", 1, 1, 1, 1, 1);
    // An unfinalized statement keeps the file open, which blocks removing it on Windows.
    ins.finalize();
    db.close();

    await runSync([codexAdapter(dbPath)], { force: true });
    const rows = await live({ active: false, agent: "codex" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "codex",
      session_id: "cx-1",
      name: "Review the diff",
      summary: "review preview text",
      cwd: "/tmp/cx",
      status: "stopped",
      tokens_used: 2540869,
      tokens_estimated: false,
    });
  });

  test("should not re-index a session whose activity only differs inside the stored second", async () => {
    const dbPath = join(root, "codex-activity.sqlite");
    const rollout = join(root, "rollout-activity.jsonl");
    writeFileSync(rollout, "");
    const activityMs = Math.floor(Date.now() / 1000) * 1000 + 999;
    utimesSync(rollout, activityMs / 1000, activityMs / 1000);
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT,
      preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT,
      created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER,
      archived INTEGER)`);
    db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "cx-activity",
      "activity",
      null,
      "/tmp/cx",
      "",
      "",
      10,
      rollout,
      activityMs,
      Math.floor(activityMs / 1000),
      activityMs,
      Math.floor(activityMs / 1000),
      0,
    );
    db.close();

    const adapter = codexAdapter(dbPath, { writer: () => false });
    const [first] = await adapter.list(new Map());
    expect(first?.usage).toBeFunction();
    if (!first) throw new Error("codex record missing");
    const known = new Map([
      [
        "cx-activity",
        {
          // The ledger keeps whole seconds; the millisecond remainder is not new work.
          lastActivityMs: Math.floor(activityMs / 1000) * 1000,
          tokensUsed: null,
          tokensVersion: 0,
          usageVersion: USAGE_EVENT_VERSION,
          session: first,
        },
      ],
    ]);
    const [second] = await adapter.list(known);
    expect(second?.usage).toBeUndefined();
  });

  test("should name the question and its tool while a live Codex session waits on request_user_input", async () => {
    const dbPath = join(root, "codex-question.sqlite");
    const asked = {
      timestamp: "2026-11-17T23:30:45.466Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_f141f9a0e5d24cefb62f33145e750eb9",
        arguments: '{"questions":[{"header":"Indentation","id":"indentation"}]}',
      },
    };
    const answered = {
      timestamp: "2026-11-17T23:31:01.850Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_f141f9a0e5d24cefb62f33145e750eb9",
        output: '{"answers":{"indentation":{"answers":["Tabs"]}}}',
      },
    };
    const waiting = join(root, "rollout-waiting.jsonl");
    const done = join(root, "rollout-answered.jsonl");
    writeFileSync(waiting, `${JSON.stringify(asked)}\n`);
    writeFileSync(done, `${JSON.stringify(asked)}\n${JSON.stringify(answered)}\n`);
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT,
      preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT,
      created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER,
      archived INTEGER)`);
    const now = Date.now();
    const ins = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const [id, rollout] of [
      ["cx-waiting", waiting],
      ["cx-answered", done],
    ] as const)
      ins.run(id, id, null, "/tmp/cx", "", "", 0, rollout, now, now / 1000, now, now / 1000, 0);
    ins.finalize();
    db.close();
    const rows = await codexAdapter(dbPath, { writer: () => true }).list(new Map());
    expect(
      Object.fromEntries(
        rows.map((row) => [row.externalId, [row.pendingHuman, row.waitingFor ?? null]]),
      ),
    ).toEqual({
      "cx-waiting": [true, { reason: "question", tool: "request_user_input" }],
      "cx-answered": [false, null],
    });
  });
});

describe("claude adapter: missing transcript", () => {
  test("settles a registry session with no transcript and keeps its lifetime total", async () => {
    const dir = join(root, "registry-without-transcript");
    mkdirSync(dir);
    const id = "0f0f0f0f-1111-4222-8333-444444444444";
    writeFileSync(
      join(dir, "987654.json"),
      JSON.stringify({
        pid: DEAD_PID,
        sessionId: id,
        cwd: "/tmp/some-repo",
        status: "stopped",
        startedAt: 1_790_000_000_000,
        updatedAt: 1_790_000_100_000,
      }),
    );
    const adapter = claudeAdapter({ registry: dir, desktop: null, projects: null });
    const [fresh] = await adapter.list(new Map());
    if (!fresh) throw new Error("claude record missing");
    expect(fresh.usageVersion).toBe(USAGE_EVENT_VERSION);
    expect(await fresh.usage?.()).toEqual({ events: [], tokens: 0, model: null });

    const [known] = await adapter.list(
      new Map([
        [
          id,
          {
            lastActivityMs: 1_790_000_100_000,
            tokensUsed: 321,
            usageVersion: 0,
            session: fresh,
          },
        ],
      ]),
    );
    const usage = await known?.usage?.();
    expect(usage?.tokens).toBe(321);
    expect(usage?.events).toEqual([
      {
        key: "session",
        ts: 1_790_000_100_000,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        otherTokens: 321,
        estimated: true,
      },
    ]);
  });

  test("settles a known session whose registry entry and transcript are both gone", async () => {
    const dir = join(root, "registry-empty");
    mkdirSync(dir);
    const id = "0f0f0f0f-1111-4222-8333-555555555555";
    const lastActivityAt = new Date(1_790_000_100_000);
    const [record] = await claudeAdapter({ registry: dir, desktop: null, projects: null }).list(
      new Map([
        [
          id,
          {
            lastActivityMs: lastActivityAt.getTime(),
            tokensUsed: 99,
            usageVersion: 0,
            session: {
              backend: "claude",
              externalId: id,
              title: "New session",
              status: "stopped" as const,
              createdAt: new Date(1_790_000_000_000),
              lastActivityAt,
            },
          },
        ],
      ]),
    );
    expect(record?.usageVersion).toBe(USAGE_EVENT_VERSION);
    expect(await record?.usage?.()).toMatchObject({ tokens: 99 });
  });
});

describe("usage indexing backlog", () => {
  test("drains more than one queue batch through follow-up syncs", async () => {
    const total = 45;
    const base = Math.floor(Date.now() / 1000) * 1000;
    const adapter: SessionAdapter = {
      backend: "pi",
      minIntervalMs: 1,
      list: async (known) =>
        Array.from({ length: total }, (_, index) => {
          const externalId = `backlog-${index}`;
          const before = known.get(externalId);
          const activity = base - (total - index) * 1000;
          return {
            backend: "pi",
            externalId,
            title: `backlog ${index}`,
            status: "stopped" as const,
            createdAt: new Date(base),
            lastActivityAt: new Date(activity),
            ...(before?.usageVersion === USAGE_EVENT_VERSION
              ? {}
              : {
                  usageVersion: USAGE_EVENT_VERSION,
                  usage: async () => ({
                    tokens: 3,
                    model: "backlog-model",
                    events: [
                      {
                        key: "request",
                        ts: activity,
                        model: "backlog-model",
                        inputTokens: 3,
                        outputTokens: 0,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                        reasoningTokens: 0,
                        otherTokens: 0,
                        estimated: false,
                      },
                    ],
                  }),
                }),
          };
        }),
    };
    const stop = startSessionWatcher({ adapters: [adapter], registryDir: null });
    let indexed = 0;
    try {
      for (let attempt = 0; attempt < 100 && indexed < total; attempt++) {
        await Bun.sleep(100);
        indexed =
          getSqlite()
            .query<{ n: number }, []>(
              `SELECT count(DISTINCT s.id) AS n FROM usage_events e
               JOIN gateway_sessions s ON s.id = e.session_id
               WHERE s.runtime_session_id LIKE 'backlog-%'`,
            )
            .get()?.n ?? 0;
      }
    } finally {
      stop();
    }
    expect(indexed).toBe(total);
  }, 15_000);
});

describe("cursor adapter", () => {
  test("should resolve the native state database on every supported platform", () => {
    expect(cursorStateDbPath("win32", "/home", { APPDATA: "/roaming" })).toBe(
      join("/roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
    );
    expect(cursorStateDbPath("win32", "/home", {})).toBe(
      join("/home", "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
    );
    expect(cursorStateDbPath("darwin", "/home", {})).toBe(
      join(
        "/home",
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    );
    expect(cursorStateDbPath("linux", "/home", { XDG_CONFIG_HOME: "/config" })).toBe(
      join("/config", "Cursor", "User", "globalStorage", "state.vscdb"),
    );
    expect(cursorStateDbPath("linux", "/home", {})).toBe(
      join("/home", ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    );
  });

  test("agent transcripts become sessions with an estimated token count", async () => {
    const dir = join(root, "cursor-target");
    const projects = join(root, "cursor-projects");
    mkdirSync(join(dir, "my-proj"), { recursive: true });
    const slug = join(dir, "my-proj")
      .replace(/^([A-Za-z]):/, "$1")
      .replace(/^[\\/]/, "")
      .replaceAll(/[\\/]/g, "-");
    expect(resolveSlugPath(slug)).toBe(join(dir, "my-proj"));

    const id = "c1adfec3-6b47-4794-af89-276b33218906";
    const transcript = join(projects, slug, "agent-transcripts", id);
    mkdirSync(transcript, { recursive: true });
    const body = JSON.stringify({
      role: "user",
      message: {
        content: [
          {
            type: "text",
            text: "<user_query>\nbuild the slack worker\n</user_query>",
          },
        ],
      },
    });
    writeFileSync(join(transcript, `${id}.jsonl`), body);
    utimesSync(join(transcript, `${id}.jsonl`), 1_700_000_000, 1_700_000_000);

    await runSync([cursorAdapter({ projects, stateDb: null })], {
      force: true,
    });
    const rows = await live({ active: false, agent: "cursor" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "cursor",
      session_id: id,
      name: "build the slack worker",
      cwd: join(dir, "my-proj"),
      status: "stopped",
      tokens_used: Math.round(body.length / 4),
      tokens_estimated: true,
    });
  });
  test("should expose an active composer through the live API and retain ended history", async () => {
    const dbPath = join(root, "cursor-state.vscdb");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const statement = db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
    const now = Date.now();
    for (const [id, updated, archived] of [
      ["cursor-active", now, false],
      ["cursor-ended", now - 60_000, false],
      ["cursor-archived", now, true],
    ] as const) {
      statement.run(
        `composerData:${id}`,
        JSON.stringify({
          name: id,
          createdAt: now - 120_000,
          lastUpdatedAt: updated,
          contextTokensUsed: 1234,
          isArchived: archived,
          fullConversationHeadersOnly: [{ grouping: { textPreview: "Cursor prompt" } }],
        }),
      );
    }
    statement.finalize();
    db.close();
    const adapter = cursorAdapter({ projects: null, stateDb: dbPath });
    expect(adapter.minIntervalMs).toBe(30_000);
    await runSync([adapter], { force: true });
    expect(await live({ agent: "cursor" })).toMatchObject([
      {
        session_id: "cursor-active",
        agent: "cursor",
        status: "running",
        summary: "Cursor prompt",
        tokens_used: 1234,
      },
    ]);
    const rows = await live({ active: false, agent: "cursor" });
    expect(rows.map((row) => row.session_id).sort()).toEqual([
      "c1adfec3-6b47-4794-af89-276b33218906",
      "cursor-active",
      "cursor-ended",
    ]);
    expect(rows.find((row) => row.session_id === "cursor-ended")?.status).toBe("stopped");
  });
});

test("failed Codex filesystem discovery preserves previously visible running sessions", async () => {
  const now = new Date();
  await runSync(
    [
      {
        backend: "codex",
        minIntervalMs: 0,
        list: async () => [
          {
            backend: "codex",
            externalId: "codex-retained-on-disconnect",
            title: "Retained session",
            status: "running",
            createdAt: now,
            lastActivityAt: now,
          },
        ],
      },
    ],
    { force: true },
  );
  const adapter = codexAdapter("/unreachable/state.sqlite", {
    runtime: {
      ...hostRuntime(LOCAL_HOST),
      isFile: async () => {
        throw new SshError("Connection reset by peer");
      },
    },
  });
  const result = await runSync([adapter], { force: true });
  expect(result[0]?.error).toContain("Connection reset");
  expect(await live({ agent: "codex" })).toMatchObject([
    { session_id: "codex-retained-on-disconnect", status: "running" },
  ]);
});

test("lists Claude sessions from every configured account directory", async () => {
  const base = mkdtempSync(join(tmpdir(), "orc-accounts-claude-"));
  try {
    const ids = ["account-a-session", "account-b-session"];
    const projectsDirs: string[] = [];
    const registryDirs: string[] = [];
    for (const [index, id] of ids.entries()) {
      const account = join(base, `account-${index}`);
      const projects = join(account, "projects");
      const registryDir = join(account, "sessions");
      mkdirSync(projects, { recursive: true });
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, `${id}.json`),
        JSON.stringify({
          pid: DEAD_PID,
          sessionId: id,
          cwd: `/tmp/account-${index}`,
          name: `Account ${index}`,
          status: "idle",
        }),
      );
      writeFileSync(
        join(projects, `${id}.jsonl`),
        JSON.stringify({ type: "user", message: { content: `prompt ${index}` } }),
      );
      projectsDirs.push(projects);
      registryDirs.push(registryDir);
    }
    const rows = await claudeAdapter({
      registry: registryDirs,
      desktop: null,
      projects: projectsDirs,
    }).list(new Map());
    expect(rows.map((row) => row.externalId).sort()).toEqual(ids);
    for (const row of rows)
      expect(row.transcriptPath).toContain(
        join(base, row.externalId === ids[0] ? "account-0" : "account-1"),
      );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("lists Codex threads from every configured account database", async () => {
  const base = mkdtempSync(join(tmpdir(), "orc-accounts-codex-"));
  try {
    const databases: string[] = [];
    for (const [index, id] of ["codex-a-thread", "codex-b-thread"].entries()) {
      const account = join(base, `account-${index}`);
      mkdirSync(join(account, "sessions"), { recursive: true });
      const database = join(account, "state_5.sqlite");
      const db = new Database(database);
      db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT,
        preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT,
        created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER,
        archived INTEGER)`);
      const insert = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
      insert.run(
        id,
        `Thread ${index}`,
        null,
        `/tmp/cx-${index}`,
        "",
        "",
        0,
        "/nope",
        1,
        1,
        1,
        1,
        0,
      );
      insert.finalize();
      db.close();
      databases.push(database);
    }
    const rows = await codexAdapter(undefined, { dbPaths: databases, writer: () => false }).list(
      new Map(),
    );
    expect(rows.map((row) => row.externalId).sort()).toEqual(["codex-a-thread", "codex-b-thread"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a corrupt Codex account database does not hide the healthy homes", async () => {
  const base = mkdtempSync(join(tmpdir(), "orc-accounts-codex-corrupt-"));
  try {
    const healthy = join(base, "healthy");
    mkdirSync(join(healthy, "sessions"), { recursive: true });
    const database = join(healthy, "state_5.sqlite");
    const db = new Database(database);
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT,
      preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT,
      created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER,
      archived INTEGER)`);
    const insert = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insert.run(
      "healthy-thread",
      "Healthy",
      null,
      "/tmp/healthy",
      "",
      "",
      0,
      "/nope",
      1,
      1,
      1,
      1,
      0,
    );
    insert.finalize();
    db.close();
    const corrupt = join(base, "corrupt", "state_5.sqlite");
    mkdirSync(join(base, "corrupt"), { recursive: true });
    writeFileSync(corrupt, "this is not a sqlite database");
    const rows = await codexAdapter(undefined, {
      dbPaths: [corrupt, database],
      writer: () => false,
    }).list(new Map());
    expect(rows.map((row) => row.externalId)).toEqual(["healthy-thread"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("duplicate session ids across Claude homes keep the first home's record together", async () => {
  const base = mkdtempSync(join(tmpdir(), "orc-accounts-claude-dup-"));
  try {
    const id = "shared-session";
    const projectsDirs: string[] = [];
    const registryDirs: string[] = [];
    for (const [index, cwd] of ["/tmp/first", "/tmp/second"].entries()) {
      const account = join(base, `account-${index}`);
      const projects = join(account, "projects");
      const registryDir = join(account, "sessions");
      mkdirSync(projects, { recursive: true });
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, `${id}.json`),
        JSON.stringify({
          pid: DEAD_PID,
          sessionId: id,
          cwd,
          name: `Account ${index}`,
          status: "idle",
        }),
      );
      writeFileSync(
        join(projects, `${id}.jsonl`),
        JSON.stringify({ type: "user", message: { content: `prompt ${index}` } }),
      );
      projectsDirs.push(projects);
      registryDirs.push(registryDir);
    }
    const rows = await claudeAdapter({
      registry: registryDirs,
      desktop: null,
      projects: projectsDirs,
    }).list(new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cwd).toBe("/tmp/first");
    expect(rows[0]?.transcriptPath).toContain(join(base, "account-0"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("duplicate thread ids across Codex homes keep the first home's record", async () => {
  const base = mkdtempSync(join(tmpdir(), "orc-accounts-codex-dup-"));
  try {
    const databases: string[] = [];
    for (const [index, cwd] of ["/tmp/first", "/tmp/second"].entries()) {
      const account = join(base, `account-${index}`);
      mkdirSync(join(account, "sessions"), { recursive: true });
      const database = join(account, "state_5.sqlite");
      const db = new Database(database);
      db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT,
        preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT,
        created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER,
        archived INTEGER)`);
      const insert = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
      insert.run("shared-thread", `Thread ${index}`, null, cwd, "", "", 0, "/nope", 1, 1, 1, 1, 0);
      insert.finalize();
      db.close();
      databases.push(database);
    }
    const rows = await codexAdapter(undefined, { dbPaths: databases, writer: () => false }).list(
      new Map(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cwd).toBe("/tmp/first");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
