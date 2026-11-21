import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopChangeTracking } from "./changes.js";
import { createDb, getSqlite } from "./client.js";
import * as schema from "./schema.js";

const tempDirs: string[] = [];
afterEach(async () => {
  // Release file-backed sqlite handles promptly; Windows can lag the release.
  Bun.gc(true);
  // Bun 1.4.4 ignores rmSync maxRetries, so retry the busy trees explicitly.
  for (const dir of tempDirs.splice(0)) {
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt >= 100) throw error;
        await Bun.sleep(100);
      }
    }
  }
}, 15_000);

describe("createDb", () => {
  test("repairs legacy task search duplicates and missing entries across repeated opens", () => {
    const dir = mkdtempSync(join(tmpdir(), "orc-task-search-"));
    tempDirs.push(dir);
    const path = join(dir, "legacy.db");
    const legacy = getSqlite(createDb(path));
    legacy.exec(`
      INSERT INTO tasks(id,title,body,tags) VALUES
        ('first','quantum fixture','searchable details','science'),
        ('second','another fixture',NULL,NULL);
      INSERT INTO tasks_fts(id,title,body,tags)
        SELECT id,title,COALESCE(body,''),COALESCE(tags,'') FROM tasks;
      INSERT INTO tasks_fts(id,title,body,tags)
        SELECT id,title,COALESCE(body,''),COALESCE(tags,'') FROM tasks;
      DELETE FROM tasks_fts WHERE id='second';
    `);
    const original = legacy.query("SELECT * FROM tasks ORDER BY id").all();
    stopChangeTracking(legacy);
    legacy.close();

    for (let attempt = 0; attempt < 3; attempt++) {
      const reopened = getSqlite(createDb(path));
      try {
        expect(reopened.query("SELECT * FROM tasks ORDER BY id").all()).toEqual(original);
        expect(
          reopened.query("SELECT id,title,body,tags FROM tasks_fts ORDER BY id").all(),
        ).toEqual([
          { id: "first", title: "quantum fixture", body: "searchable details", tags: "science" },
          { id: "second", title: "another fixture", body: "", tags: "" },
        ]);
        expect(
          reopened
            .query(
              "SELECT t.id FROM tasks_fts f JOIN tasks t ON t.id=f.id WHERE f.tasks_fts MATCH ?",
            )
            .all("quantum"),
        ).toEqual([{ id: "first" }]);
        expect(reopened.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        stopChangeTracking(reopened);
        reopened.close();
      }
    }
  });

  test("keeps task search triggers synchronized after reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "orc-task-search-triggers-"));
    tempDirs.push(dir);
    const path = join(dir, "tasks.db");
    const first = getSqlite(createDb(path));
    first.exec("INSERT INTO tasks(id,title) VALUES ('task','originalword')");
    stopChangeTracking(first);
    first.close();
    const reopened = getSqlite(createDb(path));
    const matches = (term: string) =>
      reopened.query("SELECT id FROM tasks_fts WHERE tasks_fts MATCH ?").all(term);
    try {
      expect(matches("originalword")).toEqual([{ id: "task" }]);
      reopened.exec(
        "UPDATE tasks SET title='replacementword',body='bodyword',tags='tagword' WHERE id='task'",
      );
      expect(matches("originalword")).toEqual([]);
      for (const term of ["replacementword", "bodyword", "tagword"])
        expect(matches(term)).toEqual([{ id: "task" }]);
      reopened.exec("DELETE FROM tasks WHERE id='task'");
      expect(matches("replacementword")).toEqual([]);
      reopened.exec("INSERT INTO tasks(id,title) VALUES ('task','reinsertedword')");
      expect(matches("reinsertedword")).toEqual([{ id: "task" }]);
    } finally {
      stopChangeTracking(reopened);
      reopened.close();
    }
  });

  test("replaces the legacy every-update search trigger with a text-only one", () => {
    const dir = mkdtempSync(join(tmpdir(), "orc-task-search-legacy-trigger-"));
    tempDirs.push(dir);
    const path = join(dir, "tasks.db");
    const legacy = getSqlite(createDb(path));
    legacy.exec(`DROP TRIGGER tasks_au;
      CREATE TRIGGER tasks_au AFTER UPDATE ON tasks BEGIN
        DELETE FROM tasks_fts WHERE id = old.id;
        INSERT INTO tasks_fts(id, title, body, tags)
          VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.body, ''), COALESCE(new.tags, ''));
      END;
      INSERT INTO tasks(id,title) VALUES ('task','searchword');`);
    stopChangeTracking(legacy);
    legacy.close();
    const reopened = getSqlite(createDb(path));
    const ftsRowid = () => reopened.query("SELECT rowid FROM tasks_fts WHERE id='task'").get();
    try {
      const before = ftsRowid();
      reopened.exec("UPDATE tasks SET status='doing', progress=50, updated_at=1 WHERE id='task'");
      expect(ftsRowid()).toEqual(before);
      reopened.exec("UPDATE tasks SET title='renamedword' WHERE id='task'");
      expect(
        reopened.query("SELECT id FROM tasks_fts WHERE tasks_fts MATCH 'renamedword'").all(),
      ).toEqual([{ id: "task" }]);
    } finally {
      stopChangeTracking(reopened);
      reopened.close();
    }
  });

  test("indexes foreign-key children and the task list filters", () => {
    const sqlite = getSqlite(createDb(":memory:"));
    try {
      const plan = (sql: string) =>
        (sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
          .map((row) => row.detail)
          .join(" | ");
      expect(
        plan(
          "SELECT id FROM tasks WHERE project_id='p' AND status='todo' ORDER BY updated_at DESC",
        ),
      ).toContain("USING INDEX tasks_project_status_updated_idx");
      expect(plan("SELECT id FROM sessions WHERE job_run_id='r'")).toContain(
        "sessions_job_run_idx",
      );
      expect(plan("SELECT id FROM bridge_permissions WHERE job_run_id='r'")).toContain(
        "bridge_permissions_run_idx",
      );
      expect(
        plan("SELECT id FROM gateway_sessions WHERE task_id='t' ORDER BY updated_at DESC"),
      ).toContain("gateway_sessions_task_idx");
    } finally {
      stopChangeTracking(sqlite);
      sqlite.close();
    }
  });

  test("should migrate an existing project database without losing data and reopen idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "orc-project-remote-"));
    tempDirs.push(dir);
    const path = join(dir, "legacy.db");
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'active',
      scope TEXT, tags TEXT, obsidian_path TEXT, max_workers INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    ); INSERT INTO projects(id,name,scope) VALUES ('legacy','old-project','/workspace/project');`);
    legacy.close();
    const first = getSqlite(createDb(path));
    expect(
      first.query("SELECT name,scope,git_remote_url FROM projects WHERE id='legacy'").get(),
    ).toEqual({ name: "old-project", scope: "/workspace/project", git_remote_url: null });
    first
      .query("UPDATE projects SET git_remote_url=? WHERE id='legacy'")
      .run("git@github.com:acme/repo.git");
    first.close();
    const reopened = getSqlite(createDb(path));
    expect(reopened.query("SELECT git_remote_url FROM projects WHERE id='legacy'").get()).toEqual({
      git_remote_url: "git@github.com:acme/repo.git",
    });
    reopened.close();
  });
  test("initializes an in-memory sqlite database with core tables", () => {
    const db = createDb(":memory:");
    const sqlite = getSqlite(db);
    const rows = sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    const names = new Set(rows.map((r) => r.name));
    expect(names.has("projects")).toBe(true);
    expect(names.has("tasks")).toBe(true);
    expect(names.has("jobs")).toBe(true);
    expect(names.has("sessions")).toBe(true);
    sqlite.close();
  });
});

describe("schema", () => {
  test("exports core tables", () => {
    expect(schema.projects).toBeDefined();
    expect(schema.tasks).toBeDefined();
    expect(schema.jobs).toBeDefined();
    expect(schema.sessions).toBeDefined();
  });

  test("merges twin live session rows into one and rejects a new twin", () => {
    const dir = mkdtempSync(join(tmpdir(), "orc-live-twins-"));
    tempDirs.push(dir);
    const path = join(dir, "twins.db");
    const legacy = getSqlite(createDb(path));
    legacy.exec(`
      DROP INDEX gateway_sessions_live_native_idx;
      INSERT INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, title, display_title, status, updated_at, created_at)
        VALUES ('stale', '__live-sessions__', 'claude', 'direct', 'native-1', 'nir-2c', 'My name', 'stopped', 100, 100),
               ('fresh', '__live-sessions__', 'claude', 'direct', 'native-1', 'Counting', NULL, 'stopped', 200, 100),
               ('other-host', '__live-sessions__', 'claude', 'direct', 'native-1', 'Remote', NULL, 'stopped', 100, 100);
      UPDATE gateway_sessions SET execution_host = 'box' WHERE id = 'other-host';
      INSERT INTO usage_events (id, session_id, event_key, agent, ts) VALUES ('u1', 'stale', 'k', 'claude', 1);
      INSERT INTO session_handoffs (id, request, session_id, repo_root, expires_at, status, live_session_id)
        VALUES ('h1', '{}', 'native-1', '/r', 1, 'ready', 'stale');
      INSERT INTO chat_threads (id, title, updated_at, data) VALUES ('t1', 'x', 1, '{"sourceId":"stale"}');
    `);
    stopChangeTracking(legacy);
    legacy.close();

    const reopened = getSqlite(createDb(path));
    try {
      expect(
        reopened
          .query(
            "SELECT id, display_title FROM gateway_sessions WHERE runtime_session_id='native-1' ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "fresh", display_title: "My name" },
        { id: "other-host", display_title: null },
      ]);
      expect(reopened.query("SELECT session_id FROM usage_events").all()).toEqual([
        { session_id: "fresh" },
      ]);
      expect(reopened.query("SELECT live_session_id FROM session_handoffs").get()).toEqual({
        live_session_id: "fresh",
      });
      expect(
        reopened.query("SELECT json_extract(data, '$.sourceId') AS source FROM chat_threads").get(),
      ).toEqual({ source: "fresh" });
      expect(() =>
        reopened.exec(
          "INSERT INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, status) VALUES ('again', '__live-sessions__', 'claude', 'direct', 'native-1', 'stopped')",
        ),
      ).toThrow(/UNIQUE/);
    } finally {
      stopChangeTracking(reopened);
      reopened.close();
    }
  });
});
