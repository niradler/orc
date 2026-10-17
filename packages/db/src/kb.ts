import type { Database } from "bun:sqlite";

/**
 * Knowledge base catalog in orc.db - authoritative for KBs, documents, revisions, labels, links,
 * registered folders, processing jobs (the outbox) and read accounting.
 * Chunks/FTS/vectors live in the rebuildable knowledge/index.db owned by @orc/knowledge.
 *
 * project_id has no ON DELETE action on purpose: nulling it would silently make a project's KB
 * global. Project deletion must refuse while KBs exist.
 */
export function installKnowledgeBases(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      project_id TEXT REFERENCES projects(id),
      -- JSON array of call sources (mcp, api, cli, ui) allowed to change documents.
      editable_by TEXT NOT NULL DEFAULT '["mcp","api","cli","ui"]',
      parser TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_bases_scope_name_idx
      ON knowledge_bases(coalesce(project_id, ''), name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS kb_sources (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      root_path TEXT NOT NULL,
      pattern TEXT NOT NULL,
      last_scan_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS kb_sources_root_idx ON kb_sources(kb_id, root_path);

    CREATE TABLE IF NOT EXISTS kb_documents (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL,
      labels TEXT NOT NULL DEFAULT '[]',
      origin TEXT NOT NULL,
      media_type TEXT NOT NULL,
      original_name TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      revision INTEGER NOT NULL,
      content TEXT,
      source_id TEXT REFERENCES kb_sources(id) ON DELETE SET NULL,
      external_path TEXT,
      -- An external copy edited in ORC stops following its folder file.
      folder_detached INTEGER NOT NULL DEFAULT 0,
      parse_state TEXT NOT NULL DEFAULT 'pending',
      index_state TEXT NOT NULL DEFAULT 'pending',
      parser_id TEXT,
      parser_version TEXT,
      parser_options_hash TEXT,
      warnings TEXT NOT NULL DEFAULT '[]',
      derived_from TEXT NOT NULL DEFAULT '[]',
      stale INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS kb_documents_path_idx ON kb_documents(kb_id, path COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS kb_documents_kb_idx ON kb_documents(kb_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS kb_document_revisions (
      document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      labels TEXT NOT NULL DEFAULT '[]',
      content TEXT,
      content_hash TEXT NOT NULL,
      original_rel TEXT,
      note TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL,
      source TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (document_id, revision)
    );

    CREATE TABLE IF NOT EXISTS kb_links (
      from_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
      kb_id TEXT NOT NULL,
      target TEXT NOT NULL,
      to_id TEXT,
      PRIMARY KEY (from_id, target)
    );
    CREATE INDEX IF NOT EXISTS kb_links_to_idx ON kb_links(to_id);
    CREATE INDEX IF NOT EXISTS kb_links_unresolved_idx ON kb_links(kb_id, target) WHERE to_id IS NULL;

    CREATE TABLE IF NOT EXISTS kb_jobs (
      id TEXT PRIMARY KEY,
      kb_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      parser_id TEXT,
      error TEXT,
      run_after INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS kb_jobs_work_idx ON kb_jobs(document_id, revision, kind);
    CREATE INDEX IF NOT EXISTS kb_jobs_status_idx ON kb_jobs(status, run_after);


    CREATE TABLE IF NOT EXISTS kb_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL,
      kb_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      backend TEXT,
      session_id TEXT,
      task_id TEXT,
      project_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kb_usage_events_doc_idx ON kb_usage_events(document_id, created_at);
    CREATE INDEX IF NOT EXISTS kb_usage_events_kb_idx ON kb_usage_events(kb_id, created_at);

    -- Lifetime totals survive raw-event retention pruning.
    CREATE TABLE IF NOT EXISTS kb_usage_totals (
      document_id TEXT NOT NULL,
      kb_id TEXT NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      last_at INTEGER NOT NULL,
      PRIMARY KEY (document_id, source, kind)
    );
    CREATE INDEX IF NOT EXISTS kb_usage_totals_kb_idx ON kb_usage_totals(kb_id);
  `);
}

/** Project deletion must refuse while the project still owns KBs (no silent re-scoping). */
export function projectKbCount(sqlite: Database, projectId: string): number {
  const row = sqlite
    .query("SELECT count(*) AS n FROM knowledge_bases WHERE project_id = ?")
    .get(projectId) as { n: number };
  return row.n;
}

/**
 * Databases created before knowledge bases still hold the old `knowledge_collections` table, with a
 * foreign key to projects. Its rows are kept as-is; only the project reference is cleared so the
 * project can be deleted.
 */
export function detachLegacyKnowledgeCollections(sqlite: Database, projectId: string): void {
  const legacy = sqlite
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_collections'")
    .get();
  if (!legacy) return;
  sqlite
    .query("UPDATE knowledge_collections SET project_id = NULL WHERE project_id = ?")
    .run(projectId);
}
