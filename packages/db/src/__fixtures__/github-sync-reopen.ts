import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { stopChangeTracking } from "../changes.js";
import { createDb, getSqlite } from "../client.js";

const path = process.argv[2];
if (!path) throw new Error("Database path required");
const legacy = new Database(path);
legacy.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'active', scope TEXT, git_remote_url TEXT, tags TEXT,
    obsidian_path TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
  CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), title TEXT NOT NULL,
    body TEXT, status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'normal', progress INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER, tags TEXT, author TEXT NOT NULL DEFAULT 'human', claimed_by TEXT, claim_expires_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
  INSERT INTO projects(id,name) VALUES ('p','legacy');
  INSERT INTO tasks(id,project_id,title) VALUES ('t','p','Keep this task');
`);
legacy.close();
for (let attempt = 0; attempt < 2; attempt++) {
  const sqlite = getSqlite(createDb(path));
  try {
    assert.deepEqual(sqlite.query("SELECT id,title FROM tasks").all(), [
      { id: "t", title: "Keep this task" },
    ]);
    if (attempt === 0)
      assert.deepEqual(sqlite.query("SELECT github_sync,github_sync_state FROM projects").get(), {
        github_sync: null,
        github_sync_state: null,
      });
    else
      assert.deepEqual(sqlite.query("SELECT github_sync,github_issue_id FROM tasks").get(), {
        github_sync: null,
        github_issue_id: "123",
      });
    sqlite.query("UPDATE projects SET github_sync=? WHERE id='p'").run('{"enabled":false}');
    sqlite.query("UPDATE tasks SET github_issue_id='123' WHERE id='t'").run();
    assert.throws(() =>
      sqlite
        .query(
          "INSERT INTO tasks(id,project_id,title,github_issue_id) VALUES ('duplicate','p','Duplicate','123')",
        )
        .run(),
    );
    assert.deepEqual(sqlite.query("PRAGMA integrity_check").get(), { integrity_check: "ok" });
  } finally {
    stopChangeTracking(sqlite);
    sqlite.close();
  }
}
console.log("Legacy migration and idempotent reopen passed");
