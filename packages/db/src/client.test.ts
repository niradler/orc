import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, getSqlite } from "./client.js";
import * as schema from "./schema.js";

describe("createDb", () => {
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
