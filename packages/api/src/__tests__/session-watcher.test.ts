import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createApp } from "../server.js";
import { runSync, startSessionWatcher, tokensSettled } from "../session-watcher.js";
import { claudeAdapter } from "../sessions/claude.js";
import { codexAdapter } from "../sessions/codex.js";
import { cursorAdapter, resolveSlugPath } from "../sessions/cursor.js";
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

async function live(opts: { active?: boolean; agent?: string } = {}) {
  const q = `active=${opts.active ?? true}${opts.agent ? `&agent=${opts.agent}` : ""}&limit=1000`;
  const res = await req(app, "GET", `/sessions/live?${q}`);
  expect(res.status).toBe(200);
  return (await res.json()).sessions as Row[];
}

beforeAll(() => {
  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
  rmSync(root, { recursive: true, force: true });
});

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
    const all = await live({ active: false });
    expect(all.find((r) => r.session_id === "dead-session")?.status).toBe("stopped");
    unlinkSync(join(registry, `${DEAD_PID}.json`));
  });

  test("links a task and unlinks it", async () => {
    const task = await (await req(app, "POST", "/tasks", { title: "link me" })).json();
    const [row] = await live();
    const linked = await req(app, "PATCH", `/sessions/live/${row?.id}`, { task_id: task.id });
    expect(linked.status).toBe(200);
    expect((await linked.json()).task).toMatchObject({ id: task.id, title: "link me" });
    await runSync([claude()], { force: true });
    expect((await live())[0]?.task?.id).toBe(task.id);
    const byTask = await (
      await req(app, "GET", `/sessions/live?task_id=${task.id}&active=false`)
    ).json();
    expect(byTask.sessions.map((r: { id: string }) => r.id)).toEqual([row?.id]);
    const other = await (await req(app, "GET", "/sessions/live?task_id=nope&active=false")).json();
    expect(other.sessions).toEqual([]);
    const cleared = await req(app, "PATCH", `/sessions/live/${row?.id}`, { task_id: null });
    expect((await cleared.json()).task).toBeNull();
  });

  test("rejects an unknown task and an unknown session", async () => {
    const [row] = await live();
    expect((await req(app, "PATCH", `/sessions/live/${row?.id}`, { task_id: "nope" })).status).toBe(
      404,
    );
    expect((await req(app, "PATCH", "/sessions/live/nope", { task_id: null })).status).toBe(404);
  });

  test("removing the registry file stops the session", async () => {
    unlinkSync(join(registry, `${process.pid}.json`));
    await runSync([claude()], { force: true });
    expect(await live()).toHaveLength(0);
    expect((await live({ active: false })).find((r) => r.session_id === SESSION_ID)?.status).toBe(
      "stopped",
    );
  });

  test("the fs watcher picks up a new file without a periodic sync", async () => {
    const stop = startSessionWatcher({
      adapters: [claude()],
      registryDir: registry,
      tickMs: 3_600_000,
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
      JSON.stringify({ cliSessionId: "archived-one", cwd: "/tmp/x", isArchived: true }),
    );
    const usage = (input: number, output: number, cache: number) => ({
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: cache,
      cache_read_input_tokens: 999_999,
    });
    const lines = [
      { type: "user", message: { content: "<system-reminder>ignore me</system-reminder>" } },
      { type: "user", message: { content: [{ type: "text", text: "fix the flaky test please" }] } },
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
    expect(row).toMatchObject({
      agent: "claude",
      status: "stopped",
      name: "an old session",
      cwd: "/tmp/ended-repo",
      summary: "fix the flaky test please",
      tokens_used: 66,
      tokens_estimated: false,
    });
    expect(all.some((r) => r.session_id === "archived-one")).toBe(false);
    expect((await live()).some((r) => r.session_id === id)).toBe(false);
  });
});

describe("codex adapter", () => {
  test("reads threads with exact tokens and a summary, skipping archived", async () => {
    const dbPath = join(root, "codex-state.sqlite");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT,
      preview TEXT, first_user_message TEXT, tokens_used INTEGER, rollout_path TEXT,
      created_at_ms INTEGER, created_at INTEGER, updated_at_ms INTEGER, updated_at INTEGER,
      archived INTEGER)`);
    const ins = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    ins.run(
      "cx-1",
      "Review the diff",
      null,
      "/tmp/cx",
      "review preview text",
      "first msg",
      2540869,
      "/nope/rollout.jsonl",
      1_790_000_000_000,
      1_790_000_000,
      1_790_000_900_000,
      1_790_000_900,
      0,
    );
    ins.run("cx-2", "archived", null, "/tmp/cx", "", "", 5, "/nope", 1, 1, 1, 1, 1);
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
});

describe("cursor adapter", () => {
  test("agent transcripts become sessions with an estimated token count", async () => {
    const dir = join(root, "cursor-target");
    const projects = join(root, "cursor-projects");
    mkdirSync(join(dir, "my-proj"), { recursive: true });
    const slug = join(dir, "my-proj").slice(1).replaceAll("/", "-");
    expect(resolveSlugPath(slug)).toBe(join(dir, "my-proj"));

    const id = "c1adfec3-6b47-4794-af89-276b33218906";
    const transcript = join(projects, slug, "agent-transcripts", id);
    mkdirSync(transcript, { recursive: true });
    const body = JSON.stringify({
      role: "user",
      message: {
        content: [{ type: "text", text: "<user_query>\nbuild the slack worker\n</user_query>" }],
      },
    });
    writeFileSync(join(transcript, `${id}.jsonl`), body);
    utimesSync(join(transcript, `${id}.jsonl`), 1_700_000_000, 1_700_000_000);

    await runSync([cursorAdapter({ projects, stateDb: null })], { force: true });
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
});
