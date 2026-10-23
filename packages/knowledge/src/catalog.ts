import type { Database } from "bun:sqlite";
import type {
  KbCallSource,
  KbDocOrigin,
  KbDocument,
  KbIndexState,
  KbParseState,
  KbRevision,
  KnowledgeBase,
} from "@orc/core/kb";

/** Row shapes and mappers for the orc.db catalog tables (see @orc/db/kb). */

export type KbRow = {
  id: string;
  name: string;
  description: string;
  project_id: string | null;
  /** JSON array of the call sources allowed to change documents. */
  editable_by: string;
  parser: string | null;
  created_at: number;
  updated_at: number;
  document_count?: number;
};

export type DocRow = {
  id: string;
  kb_id: string;
  title: string;
  description: string;
  path: string;
  labels: string;
  origin: KbDocOrigin;
  media_type: string;
  original_name: string | null;
  size_bytes: number;
  content_hash: string;
  revision: number;
  content: string | null;
  source_id: string | null;
  external_path: string | null;
  folder_detached: number;
  parse_state: KbParseState;
  index_state: KbIndexState;
  parser_id: string | null;
  parser_version: string | null;
  parser_options_hash: string | null;
  warnings: string;
  derived_from: string;
  stale: number;
  created_at: number;
  updated_at: number;
  updated_by: string;
};

export type RevisionRow = {
  chunk_version: number;
  document_id: string;
  revision: number;
  title: string;
  path: string;
  labels: string;
  content: string | null;
  content_hash: string;
  original_rel: string | null;
  note: string;
  actor: string;
  source: KbCallSource;
  session_id: string | null;
  created_at: number;
};

export type JobRow = {
  id: string;
  kb_id: string;
  document_id: string;
  revision: number;
  kind: JobKind;
  status: "queued" | "running" | "done" | "failed" | "superseded";
  attempts: number;
  parser_id: string | null;
  error: string | null;
  run_after: number;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
};
export type JobKind = "parse" | "index" | "embed";

export type SourceRow = {
  id: string;
  kb_id: string;
  root_path: string;
  pattern: string;
  last_scan_at: number | null;
  last_error: string | null;
  created_at: number;
};

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export const toKb = (r: KbRow): KnowledgeBase => ({
  id: r.id,
  name: r.name,
  description: r.description,
  project_id: r.project_id,
  editable_by: json<KbCallSource[]>(r.editable_by, []),
  parser: r.parser,
  document_count: r.document_count ?? 0,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

export const isEditable = (r: Pick<DocRow, "origin" | "media_type">) =>
  r.origin === "authored" || (r.origin === "external" && r.media_type === "text/markdown");

export const toDoc = (r: DocRow): KbDocument => ({
  id: r.id,
  kb_id: r.kb_id,
  title: r.title,
  description: r.description,
  path: r.path,
  labels: json<string[]>(r.labels, []),
  origin: r.origin,
  media_type: r.media_type,
  original_name: r.original_name,
  size_bytes: r.size_bytes,
  content_hash: r.content_hash,
  revision: r.revision,
  editable: isEditable(r),
  folder_sync: r.origin === "external" ? (r.folder_detached ? "detached" : "following") : null,
  parse_state: r.parse_state,
  index_state: r.index_state,
  parser:
    r.parser_id && r.parser_version
      ? { id: r.parser_id, version: r.parser_version, options_hash: r.parser_options_hash ?? "" }
      : null,
  warnings: json<string[]>(r.warnings, []),
  stale: !!r.stale,
  derived_from: json<string[]>(r.derived_from, []),
  created_at: r.created_at,
  updated_at: r.updated_at,
  updated_by: r.updated_by,
});

export const toRevision = (r: RevisionRow): KbRevision => ({
  document_id: r.document_id,
  revision: r.revision,
  title: r.title,
  path: r.path,
  labels: json<string[]>(r.labels, []),
  content_hash: r.content_hash,
  note: r.note,
  actor: r.actor,
  source: r.source,
  session_id: r.session_id,
  created_at: r.created_at,
});

export const DOC_COLUMNS = `id, kb_id, title, description, path, labels, origin, media_type, original_name,
  size_bytes, content_hash, revision, content, source_id, external_path, folder_detached, parse_state, index_state,
  parser_id, parser_version, parser_options_hash, warnings, derived_from, stale, created_at, updated_at, updated_by`;

export class Catalog {
  constructor(readonly db: Database) {}

  kb(id: string): KbRow | null {
    return this.db
      .query(
        `SELECT k.*, (SELECT count(*) FROM kb_documents d WHERE d.kb_id = k.id) AS document_count
         FROM knowledge_bases k WHERE k.id = ?`,
      )
      .get(id) as KbRow | null;
  }

  doc(id: string): DocRow | null {
    return this.db
      .query(`SELECT ${DOC_COLUMNS} FROM kb_documents WHERE id = ?`)
      .get(id) as DocRow | null;
  }

  docByPath(kbId: string, path: string): DocRow | null {
    return this.db
      .query(`SELECT ${DOC_COLUMNS} FROM kb_documents WHERE kb_id = ? AND path = ? COLLATE NOCASE`)
      .get(kbId, path) as DocRow | null;
  }

  revision(docId: string, revision: number): RevisionRow | null {
    return this.db
      .query("SELECT * FROM kb_document_revisions WHERE document_id = ? AND revision = ?")
      .get(docId, revision) as RevisionRow | null;
  }

  projectExists(id: string): boolean {
    return !!this.db.query("SELECT 1 FROM projects WHERE id = ?").get(id);
  }

  /** Inserts or re-queues a unit of work; the same (doc, revision, kind) is never queued twice. */
  enqueue(kbId: string, docId: string, revision: number, kind: JobKind, id: string, delayMs = 0) {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO kb_jobs (id, kb_id, document_id, revision, kind, status, attempts, run_after, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
         ON CONFLICT(document_id, revision, kind) DO UPDATE SET
           status = 'queued', attempts = 0, error = NULL, run_after = excluded.run_after,
           started_at = NULL, finished_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(id, kbId, docId, revision, kind, now + delayMs, now, now);
  }
}
