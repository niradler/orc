import type { Database } from "bun:sqlite";
import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import type { OrcNotification } from "@orc/core/notifications";

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

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const DEFAULT_CLEANUP_BATCH = 1000;
const ID_ATTEMPTS = 8;

function retentionCutoff(retentionDays: number, nowMs: number): number {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650)
    throw new RangeError("Audit retention must be an integer from 1 to 3650 days");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new RangeError("Audit cleanup time must be a nonnegative integer timestamp");
  return Math.floor((nowMs - retentionDays * DAY_MS) / 1000);
}

/** Expired rows are removed in bounded batches without generating more audit rows. */
export function cleanupAuditLog(
  sqlite: Database,
  retentionDays = DEFAULT_AUDIT_RETENTION_DAYS,
  nowMs = Date.now(),
  batchSize = DEFAULT_CLEANUP_BATCH,
): number {
  const cutoff = retentionCutoff(retentionDays, nowMs);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000)
    throw new RangeError("Audit cleanup batch must be an integer from 1 to 10000 rows");
  return sqlite
    .query(
      `DELETE FROM audit_log WHERE rowid IN (
        SELECT rowid FROM audit_log WHERE created_at <= ? ORDER BY created_at, rowid LIMIT ?
      )`,
    )
    .run(cutoff, batchSize).changes;
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
  projectIds?: readonly string[];
  projectId?: string | null | undefined;
  entityType?: string | undefined;
  sessionId?: string | undefined;
  since?: number | undefined;
  limit?: number | undefined;
  snapshot?: "preview" | "full";
};

export type AuditLogOptions = {
  now?: (() => number) | undefined;
  retentionDays?: (() => number) | undefined;
  generateId?: (() => string) | undefined;
};

export type NotificationAuditAction =
  | "notification.created"
  | "notification.read"
  | "notification.unread"
  | "notification.dismissed"
  | "notification.restored"
  | "notification.resolved"
  | "notification.expired"
  | "notification.superseded"
  | "notification.deleted";

export type NotificationAuditItem = Pick<
  OrcNotification,
  | "id"
  | "type"
  | "source_id"
  | "title"
  | "body"
  | "level"
  | "project_id"
  | "created_at"
  | "expires_at"
  | "read_at"
  | "dismissed_at"
> & { requires_action: boolean | number };

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

// Actions are "<entity>.<verb>" (memory.merged, kb.created), so the entity is the prefix.
function entityOf(action: string): string {
  return action.split(".")[0] ?? action;
}

export class AuditLog {
  constructor(
    private readonly sqlite: Database,
    private readonly options: AuditLogOptions = {},
  ) {}

  private cutoff(): number {
    return retentionCutoff(
      this.options.retentionDays?.() ??
        loadConfig().preferences.audit_retention_days ??
        DEFAULT_AUDIT_RETENTION_DAYS,
      this.options.now?.() ?? Date.now(),
    );
  }

  record(input: AuditInput): string {
    const insert = this.sqlite.query(
      `INSERT INTO audit_log(id, created_at, action, entity_type, project_id, actor, session_id, subject_ids, result_ids, note, snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const createdAt = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
    const subjectIds = JSON.stringify(input.subject_ids);
    const resultIds = JSON.stringify(input.result_ids ?? []);
    const snapshot = input.snapshot === undefined ? null : JSON.stringify(input.snapshot);
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      const id = (this.options.generateId ?? ulid)();
      try {
        insert.run(
          id,
          createdAt,
          input.action,
          entityOf(input.action),
          input.project_id ?? null,
          input.actor ?? null,
          input.session_id ?? null,
          subjectIds,
          resultIds,
          input.note ?? null,
          snapshot,
        );
        return id;
      } catch (error) {
        if (
          attempt === ID_ATTEMPTS - 1 ||
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "SQLITE_CONSTRAINT_PRIMARYKEY" ||
          !this.sqlite
            .query<{ id: string }, [string]>("SELECT id FROM audit_log WHERE id=?")
            .get(id)
        )
          throw error;
      }
    }
    throw new Error("Audit ID allocation exhausted");
  }

  list(query: AuditQuery = {}): AuditEntry[] {
    const conditions: string[] = ["created_at > ?"];
    const params: (string | number | null)[] = [this.cutoff()];
    if (query.projectIds) {
      conditions.push(`project_id IN (${query.projectIds.map(() => "?").join(",") || "NULL"})`);
      params.push(...query.projectIds);
    } else if (query.projectId !== undefined) {
      conditions.push("project_id IS ?");
      params.push(query.projectId);
    }
    if (query.entityType) {
      conditions.push("entity_type = ?");
      params.push(query.entityType);
    }
    if (query.sessionId !== undefined) {
      conditions.push("session_id = ?");
      params.push(query.sessionId);
    }
    if (query.since !== undefined) {
      conditions.push("created_at >= ?");
      params.push(query.since);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const snapshot =
      query.snapshot === "preview"
        ? "CASE WHEN length(CAST(snapshot AS BLOB)) > 4096 THEN json_object('preview_truncated',json('true'),'bytes',length(CAST(snapshot AS BLOB))) ELSE snapshot END"
        : "snapshot";
    return this.sqlite
      .query<AuditRow, (string | number | null)[]>(
        `SELECT id,created_at,action,entity_type,project_id,actor,session_id,subject_ids,result_ids,note,${snapshot} AS snapshot
         FROM audit_log ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, query.limit ?? DEFAULT_LIMIT)
      .map(toEntry);
  }

  // Latest entry with one of these actions on the id, e.g. to explain where a removed memory went.
  findLatest(subjectId: string, actions: string[]): AuditEntry | null {
    const row = this.sqlite
      .query<AuditRow, (string | number)[]>(
        `SELECT a.* FROM audit_log a, json_each(a.subject_ids) s
         WHERE s.value = ? AND a.action IN (${actions.map(() => "?").join(",")}) AND a.created_at > ?
         ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
      )
      .get(subjectId, ...actions, this.cutoff());
    return row ? toEntry(row) : null;
  }
}

/** Retain the bounded notification itself; writers never add the source's tool or response payload. */
export function recordNotificationAudit(
  sqlite: Database,
  action: NotificationAuditAction,
  item: NotificationAuditItem,
  options: AuditActor & Pick<AuditLogOptions, "now"> = {},
): string {
  return new AuditLog(sqlite, { now: options.now }).record({
    action,
    project_id: item.project_id,
    actor: options.actor,
    session_id: options.session_id,
    subject_ids: [item.id],
    snapshot: {
      type: item.type.slice(0, 100),
      title: item.title.slice(0, 200),
      body: item.body.slice(0, 500),
      level: item.level,
      source_id: item.source_id.slice(0, 256),
      requires_action: Boolean(item.requires_action),
      created_at: item.created_at,
      expires_at: item.expires_at,
      read: item.read_at !== null,
      dismissed: item.dismissed_at !== null,
    },
  });
}
