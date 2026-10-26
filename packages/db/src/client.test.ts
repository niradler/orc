import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopChangeTracking } from "./changes.js";
import { createDb, getSqlite } from "./client.js";
import * as schema from "./schema.js";

describe("createDb", () => {
  test("repairs legacy task search duplicates and missing entries across repeated opens", () => {
    const path = join(mkdtempSync(join(tmpdir(), "orc-task-search-")), "legacy.db");
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
    const path = join(mkdtempSync(join(tmpdir(), "orc-task-search-triggers-")), "tasks.db");
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
    const path = join(mkdtempSync(join(tmpdir(), "orc-task-search-legacy-trigger-")), "tasks.db");
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
    const path = join(mkdtempSync(join(tmpdir(), "orc-project-remote-")), "legacy.db");
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
});
