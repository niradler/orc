import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "@orc/core/config";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.js";

export type OrcDb = ReturnType<typeof createDb>;

let _db: OrcDb | null = null;

function setupDb(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      scope TEXT,
      tags TEXT,
      obsidian_path TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      title TEXT NOT NULL,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'normal',
      due_at INTEGER,
      tags TEXT,
      author TEXT NOT NULL DEFAULT 'human',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS task_notes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'human',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS task_links (
      id TEXT PRIMARY KEY,
      from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      to_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS task_links_from_idx ON task_links(from_task_id);
    CREATE INDEX IF NOT EXISTS task_links_to_idx ON task_links(to_task_id);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source TEXT,
      scope TEXT,
      tags TEXT,
      importance TEXT NOT NULL DEFAULT 'normal',
      expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      template TEXT NOT NULL,
      is_skill INTEGER NOT NULL DEFAULT 0,
      skill_dir TEXT,
      skill_version TEXT,
      frontmatter TEXT,
      tags TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS prompts_name_idx ON prompts(name);

    CREATE TABLE IF NOT EXISTS prompt_history (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      template TEXT NOT NULL,
      tags TEXT,
      changed_by TEXT NOT NULL DEFAULT 'human',
      changed_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS prompt_history_prompt_id_idx ON prompt_history(prompt_id, version);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      command TEXT NOT NULL,
      prompt_id TEXT REFERENCES prompts(id),
      prompt_vars TEXT,
      inject_context INTEGER NOT NULL DEFAULT 1,
      trigger_type TEXT NOT NULL,
      cron_expr TEXT,
      repeat_secs INTEGER,
      watch_path TEXT,
      run_at INTEGER,
      timeout_secs INTEGER NOT NULL DEFAULT 300,
      max_retries INTEGER NOT NULL DEFAULT 0,
      overlap TEXT NOT NULL DEFAULT 'skip',
      env_vars TEXT,
      working_dir TEXT,
      notify_on TEXT NOT NULL DEFAULT 'failure',
      notify_channel TEXT NOT NULL DEFAULT 'telegram',
      os_installed INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS jobs_name_idx ON jobs(name);

    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      trigger_by TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      error_msg TEXT,
      retry_num INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS job_runs_job_id_idx ON job_runs(job_id);

    CREATE TABLE IF NOT EXISTS job_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      stream TEXT NOT NULL,
      line TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS job_run_logs_run_id_idx ON job_run_logs(run_id, ts);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id),
      job_run_id TEXT REFERENCES job_runs(id),
      summary TEXT,
      events TEXT,
      snapshot TEXT,
      tokens_used INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS bridge_chats (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      username TEXT,
      mode TEXT NOT NULL DEFAULT 'direct',
      authorized INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS bridge_chats_platform_chat_idx ON bridge_chats(platform, chat_id);

    CREATE TABLE IF NOT EXISTS bridge_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT REFERENCES bridge_chats(id),
      direction TEXT NOT NULL,
      text TEXT,
      job_run_id TEXT REFERENCES job_runs(id),
      platform_msg_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS bridge_permissions (
      id TEXT PRIMARY KEY,
      chat_id TEXT,
      job_run_id TEXT REFERENCES job_runs(id),
      tool TEXT NOT NULL,
      command TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      content,
      tags,
      scope UNINDEXED,
      tokenize='porter ascii'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(id, content, tags, scope)
        VALUES (new.id, new.content, COALESCE(new.tags, ''), COALESCE(new.scope, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      DELETE FROM memories_fts WHERE id = old.id;
      INSERT INTO memories_fts(id, content, tags, scope)
        VALUES (new.id, new.content, COALESCE(new.tags, ''), COALESCE(new.scope, ''));
    END;

    CREATE TABLE IF NOT EXISTS session_events (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type       TEXT NOT NULL,
      priority   INTEGER NOT NULL DEFAULT 3,
      data       TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, priority, created_at DESC);

    CREATE TABLE IF NOT EXISTS session_snapshots (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      xml        TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_session ON session_snapshots(session_id, created_at DESC);
  `);
}

export function createDb(dbPath?: string): ReturnType<typeof drizzle<typeof schema>> {
  const config = loadConfig();
  const path = dbPath ?? config.db.path;

  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);
  sqlite.exec("PRAGMA journal_mode=WAL;");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  sqlite.exec("PRAGMA synchronous=NORMAL;");

  setupDb(sqlite);

  return drizzle(sqlite, { schema });
}

export function getDb(): OrcDb {
  if (!_db) _db = createDb();
  return _db;
}

export function closeDb(): void {
  _db = null;
}
