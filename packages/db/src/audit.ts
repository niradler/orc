import type { Database } from "bun:sqlite";
import { ulid } from "@orc/core/ids";

export function installAudit(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      project_id TEXT,
      actor TEXT,
      session_id TEXT,
      subject_ids TEXT NOT NULL DEFAULT '[]',
      result_ids TEXT NOT NULL DEFAULT '[]',
      note TEXT,
      snapshot TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_log_recent_idx ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_log_project_idx ON audit_log(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log(entity_type, created_at DESC);
  `);
}

export type AuditActor = {
  actor?: string | null | undefined;
  session_id?: string | null | undefined;
};

export type AuditInput = AuditActor & {
  action: string;
  subject_ids: string[];
  result_ids?: string[] | undefined;
  project_id?: string | null | undefined;
  note?: string | null | undefined;
  snapshot?: unknown;
};

export type AuditEntry = {
  id: string;
  created_at: number;
  action: string;
  entity_type: string;
  project_id: string | null;
  actor: string | null;
  session_id: string | null;
  subject_ids: string[];
  result_ids: string[];
  note: string | null;
  snapshot: unknown;
};

export type AuditQuery = {
  projectId?: string | null | undefined;
  entityType?: string | undefined;
  since?: number | undefined;
  limit?: number | undefined;
};

type AuditRow = Omit<AuditEntry, "subject_ids" | "result_ids" | "snapshot"> & {
  subject_ids: string;
  result_ids: string;
  snapshot: string | null;
};

const DEFAULT_LIMIT = 50;

function toEntry(row: AuditRow): AuditEntry {
  return {
    ...row,
    subject_ids: JSON.parse(row.subject_ids) as string[],
    result_ids: JSON.parse(row.result_ids) as string[],
    snapshot: row.snapshot === null ? null : JSON.parse(row.snapshot),
  };
}

// Actions are "<entity>.<verb>" (memory.merged, wiki.written), so the entity is the prefix.
function entityOf(action: string): string {
  return action.split(".")[0] ?? action;
}

export class AuditLog {
  constructor(private readonly sqlite: Database) {}

  record(input: AuditInput): string {
    const id = ulid();
    this.sqlite
      .query(
        `INSERT INTO audit_log(id, created_at, action, entity_type, project_id, actor, session_id, subject_ids, result_ids, note, snapshot)
         VALUES (?, unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.action,
        entityOf(input.action),
        input.project_id ?? null,
        input.actor ?? null,
        input.session_id ?? null,
        JSON.stringify(input.subject_ids),
        JSON.stringify(input.result_ids ?? []),
        input.note ?? null,
        input.snapshot === undefined ? null : JSON.stringify(input.snapshot),
      );
    return id;
  }

  list(query: AuditQuery = {}): AuditEntry[] {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];
    if (query.projectId !== undefined) {
      conditions.push("project_id IS ?");
      params.push(query.projectId);
    }
    if (query.entityType) {
      conditions.push("entity_type = ?");
      params.push(query.entityType);
    }
    if (query.since !== undefined) {
      conditions.push("created_at >= ?");
      params.push(query.since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.sqlite
      .query<AuditRow, (string | number | null)[]>(
        `SELECT * FROM audit_log ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, query.limit ?? DEFAULT_LIMIT)
      .map(toEntry);
  }

  // Latest entry with one of these actions on the id, e.g. to explain where a removed memory went.
  findLatest(subjectId: string, actions: string[]): AuditEntry | null {
    const row = this.sqlite
      .query<AuditRow, string[]>(
        `SELECT a.* FROM audit_log a, json_each(a.subject_ids) s
         WHERE s.value = ? AND a.action IN (${actions.map(() => "?").join(",")})
         ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
      )
      .get(subjectId, ...actions);
    return row ? toEntry(row) : null;
  }
}
