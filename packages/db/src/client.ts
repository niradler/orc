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
      progress INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER,
      tags TEXT,
      author TEXT NOT NULL DEFAULT 'human',
      claimed_by TEXT,
      claim_expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'human',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS comments_resource_idx ON comments(resource_type, resource_id);

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
      title TEXT,
      type TEXT NOT NULL DEFAULT 'fact',
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
      agent_version TEXT,
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
      display_name TEXT,
      mode TEXT NOT NULL DEFAULT 'direct',
      authorized INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      thread_id TEXT,
      working_dir TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE UNIQUE INDEX IF NOT EXISTS bridge_chats_platform_chat_idx ON bridge_chats(platform, chat_id);

    CREATE TABLE IF NOT EXISTS gateway_sessions (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES bridge_chats(id) ON DELETE CASCADE,
      backend TEXT NOT NULL,
      mode TEXT NOT NULL,
      runtime_session_id TEXT,
      cwd TEXT,
      title TEXT,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      last_activity_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS gateway_sessions_chat_idx ON gateway_sessions(chat_id, updated_at);

    CREATE TABLE IF NOT EXISTS bridge_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT REFERENCES bridge_chats(id),
      direction TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      text TEXT,
      job_run_id TEXT REFERENCES job_runs(id),
      gateway_session_id TEXT REFERENCES gateway_sessions(id),
      platform_msg_id TEXT,
      thread_id TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS bridge_permissions (
      id TEXT PRIMARY KEY,
      chat_id TEXT,
      gateway_session_id TEXT REFERENCES gateway_sessions(id),
      job_run_id TEXT REFERENCES job_runs(id),
      tool TEXT NOT NULL,
      command TEXT,
      scope TEXT NOT NULL DEFAULT 'once',
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at INTEGER,
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
      title,
      tags,
      scope UNINDEXED,
      tokenize='porter ascii'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts_trigram USING fts5(
      id UNINDEXED,
      content,
      title,
      tags,
      scope UNINDEXED,
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(id, content, title, tags, scope)
        VALUES (new.id, new.content, COALESCE(new.title, ''), COALESCE(new.tags, ''), COALESCE(new.scope, ''));
      INSERT INTO memories_fts_trigram(id, content, title, tags, scope)
        VALUES (new.id, new.content, COALESCE(new.title, ''), COALESCE(new.tags, ''), COALESCE(new.scope, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE id = old.id;
      DELETE FROM memories_fts_trigram WHERE id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      DELETE FROM memories_fts WHERE id = old.id;
      DELETE FROM memories_fts_trigram WHERE id = old.id;
      INSERT INTO memories_fts(id, content, title, tags, scope)
        VALUES (new.id, new.content, COALESCE(new.title, ''), COALESCE(new.tags, ''), COALESCE(new.scope, ''));
      INSERT INTO memories_fts_trigram(id, content, title, tags, scope)
        VALUES (new.id, new.content, COALESCE(new.title, ''), COALESCE(new.tags, ''), COALESCE(new.scope, ''));
    END;

    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
      id UNINDEXED,
      title,
      body,
      tags,
      tokenize='porter ascii'
    );

    CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
      INSERT INTO tasks_fts(id, title, body, tags)
        VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.body, ''), COALESCE(new.tags, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
      DELETE FROM tasks_fts WHERE id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
      DELETE FROM tasks_fts WHERE id = old.id;
      INSERT INTO tasks_fts(id, title, body, tags)
        VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.body, ''), COALESCE(new.tags, ''));
    END;

    INSERT OR IGNORE INTO tasks_fts(id, title, body, tags)
      SELECT id, COALESCE(title, ''), COALESCE(body, ''), COALESCE(tags, '')
      FROM tasks;

    CREATE TABLE IF NOT EXISTS session_events (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type       TEXT NOT NULL,
      priority   INTEGER NOT NULL DEFAULT 3,
      data       TEXT NOT NULL,
      data_hash  TEXT,
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

  const migrations = [
    "ALTER TABLE memories ADD COLUMN title TEXT",
    "ALTER TABLE memories ADD COLUMN type TEXT NOT NULL DEFAULT 'fact'",
    "ALTER TABLE session_events ADD COLUMN data_hash TEXT",
    "ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN claimed_by TEXT",
    "ALTER TABLE tasks ADD COLUMN claim_expires_at INTEGER",
    "ALTER TABLE sessions ADD COLUMN agent_version TEXT",
    "ALTER TABLE bridge_chats ADD COLUMN display_name TEXT",
    "ALTER TABLE bridge_chats ADD COLUMN thread_id TEXT",
    "ALTER TABLE bridge_chats ADD COLUMN working_dir TEXT",
    "ALTER TABLE bridge_chats ADD COLUMN updated_at INTEGER NOT NULL DEFAULT (unixepoch())",
    "ALTER TABLE bridge_messages ADD COLUMN role TEXT NOT NULL DEFAULT 'user'",
    "ALTER TABLE bridge_messages ADD COLUMN gateway_session_id TEXT REFERENCES gateway_sessions(id)",
    "ALTER TABLE bridge_messages ADD COLUMN thread_id TEXT",
    "ALTER TABLE bridge_messages ADD COLUMN metadata TEXT",
    "ALTER TABLE bridge_permissions ADD COLUMN gateway_session_id TEXT REFERENCES gateway_sessions(id)",
    "ALTER TABLE bridge_permissions ADD COLUMN scope TEXT NOT NULL DEFAULT 'once'",
    "ALTER TABLE bridge_permissions ADD COLUMN message TEXT",
    "ALTER TABLE bridge_permissions ADD COLUMN expires_at INTEGER",
    "ALTER TABLE gateway_sessions ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE gateway_sessions ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL",
    "UPDATE jobs SET enabled=0 WHERE trigger_type='repeat'",
    "ALTER TABLE memories ADD COLUMN project_id TEXT REFERENCES projects(id)",
    "ALTER TABLE jobs ADD COLUMN project_id TEXT REFERENCES projects(id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS projects_name_idx ON projects(name)",
    "ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER",
    "INSERT INTO comments (id, resource_type, resource_id, content, author, created_at) SELECT id, 'task', task_id, content, author, created_at FROM task_notes WHERE 1",
    "DROP TABLE IF EXISTS task_notes",
    "DROP TABLE IF EXISTS task_comments",
    "DROP TABLE IF EXISTS project_comments",
    "ALTER TABLE tasks ADD COLUMN prompt_id TEXT REFERENCES prompts(id) ON DELETE SET NULL",
    "ALTER TABLE tasks ADD COLUMN required_review INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE tasks ADD COLUMN agent_backend TEXT",
    "ALTER TABLE tasks ADD COLUMN max_review_rounds INTEGER NOT NULL DEFAULT 3",
    "ALTER TABLE gateway_sessions ADD COLUMN role TEXT",
    "ALTER TABLE gateway_sessions ADD COLUMN pid INTEGER",
    "ALTER TABLE gateway_sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL",
    "ALTER TABLE gateway_sessions ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE projects ADD COLUMN max_workers INTEGER",
  ];
  for (const statement of migrations) {
    try {
      sqlite.exec(statement);
    } catch {}
  }

  try {
    sqlite.exec(`INSERT OR IGNORE INTO bridge_chats (id, platform, chat_id, mode, authorized, updated_at, created_at)
      VALUES ('__task-loop__', 'telegram', '__task-loop__', 'direct', 0, unixepoch(), unixepoch())`);
  } catch {}
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

export function createTestDb(): OrcDb {
  _db = createDb(":memory:");
  return _db;
}

export function closeDb(): void {
  _db = null;
}
