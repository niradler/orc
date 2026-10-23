import type { Database } from "bun:sqlite";

export function installSessionArchive(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_archives (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      source_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      native_id TEXT NOT NULL,
      title TEXT NOT NULL,
      metadata TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      index_revision INTEGER NOT NULL DEFAULT 0,
      embedding_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_id, agent, native_id)
    );
    CREATE INDEX IF NOT EXISTS session_archives_project ON session_archives(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS session_archives_activity ON session_archives(updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS session_archives_pending ON session_archives(updated_at) WHERE revision != index_revision;
    CREATE TABLE IF NOT EXISTS session_archive_revisions (
      session_id TEXT NOT NULL REFERENCES session_archives(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      file_hashes TEXT NOT NULL,
      blob TEXT NOT NULL,
      conflict INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, revision)
    );
    CREATE TRIGGER IF NOT EXISTS session_archive_project_changed AFTER UPDATE OF project_id ON session_archives
    BEGIN UPDATE session_archives SET index_revision = 0 WHERE id = NEW.id; END;
    CREATE TABLE IF NOT EXISTS session_archive_handoffs (
      archive_id TEXT NOT NULL REFERENCES session_archives(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      handoff_id TEXT NOT NULL REFERENCES session_handoffs(id) ON DELETE CASCADE,
      PRIMARY KEY(archive_id, handoff_id)
    );
    CREATE TABLE IF NOT EXISTS session_sync_grants (
      token_hash TEXT PRIMARY KEY,
      project_ids TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
}
