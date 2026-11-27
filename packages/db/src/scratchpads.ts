import type { Database } from "bun:sqlite";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import {
  emptyScratchpadContent,
  type Scratchpad,
  type ScratchpadCreate,
  type ScratchpadListItem,
  type ScratchpadListQuery,
  type ScratchpadUpdate,
  validateScratchpadContent,
} from "@orc/core/scratchpad";
import { normalizeTags } from "@orc/core/tags";
import { parseTtlSeconds } from "@orc/core/ttl";
import { restoreTtl, scheduleTtl } from "./ttl.js";

type Row = Omit<Scratchpad, "tags" | "pinned" | "keep_alive"> & {
  tags: string | null;
  pinned: number;
  keep_alive: number;
};
type Revisions = { revision: number; content_revision: number };
type ListRow = Omit<ScratchpadListItem, "tags" | "pinned" | "keep_alive"> & {
  tags: string | null;
  pinned: number;
  keep_alive: number;
};

export type ScratchpadExpiryOutcome = {
  archived: number;
  skipped: { id: string; reason: string }[];
};

/** An expiry write; null from `resolveExpiry` means "leave the current expiry alone". */
type ExpiryChange = { expires_at: number | null; ttl_seconds: number | null };

// session_id is the agent's native session id, like memories.session_id: pads come from several
// session sources (live, archived, plain agent CLI), so there is no single table to reference.
export function installScratchpads(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS scratchpads (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT,
      tags TEXT,
      author TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      content_revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      archived_at INTEGER,
      delete_after INTEGER,
      expires_at INTEGER,
      ttl_seconds INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0,
      keep_alive INTEGER NOT NULL DEFAULT 0,
      expiry_skipped_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS scratchpads_project_idx ON scratchpads(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS scratchpads_session_idx ON scratchpads(session_id);
    CREATE INDEX IF NOT EXISTS scratchpads_delete_after_idx
      ON scratchpads(delete_after) WHERE delete_after IS NOT NULL;
  `);
  const columns = sqlite.query<{ name: string }, []>("PRAGMA table_info(scratchpads)").all();
  for (const [name, definition] of [
    ["expires_at", "INTEGER"],
    ["ttl_seconds", "INTEGER"],
    ["pinned", "INTEGER NOT NULL DEFAULT 0"],
    ["keep_alive", "INTEGER NOT NULL DEFAULT 0"],
    ["expiry_skipped_reason", "TEXT"],
  ] as const)
    if (!columns.some((column) => column.name === name))
      sqlite.exec(`ALTER TABLE scratchpads ADD COLUMN ${name} ${definition}`);
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS scratchpads_expires_at_idx ON scratchpads(expires_at) WHERE expires_at IS NOT NULL;",
  );
}

function parse<T extends { tags: string | null; pinned: number; keep_alive: number }>(
  row: T,
): Omit<T, "tags" | "pinned" | "keep_alive"> & {
  tags: string[];
  pinned: boolean;
  keep_alive: boolean;
} {
  return {
    ...row,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    pinned: row.pinned === 1,
    keep_alive: row.keep_alive === 1,
  };
}

function tagsColumn(tags: string[] | undefined): string | null {
  const normalized = normalizeTags(tags ?? []);
  return normalized.length ? JSON.stringify(normalized) : null;
}

/**
 * Turns `ttl` / `expires_at` into stored values. Undefined means "no change";
 * an explicit null clears. A duration keeps its window so `keep_alive` can slide it.
 */
function resolveExpiry(
  input:
    | Pick<ScratchpadCreate, "ttl" | "expires_at">
    | Pick<ScratchpadUpdate, "ttl" | "expires_at">,
  now: Date,
): ExpiryChange | null {
  if (input.ttl === undefined && input.expires_at === undefined) return null;
  if (typeof input.ttl === "string" && typeof input.expires_at === "number")
    throw new ValidationError("Supply either ttl or expires_at, not both");
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (typeof input.ttl === "string") {
    const ttl_seconds = parseTtlSeconds(input.ttl);
    return { expires_at: nowSeconds + ttl_seconds, ttl_seconds };
  }
  if (typeof input.expires_at === "number") {
    if (input.expires_at <= nowSeconds)
      throw new ValidationError("expires_at must be in the future");
    return { expires_at: input.expires_at, ttl_seconds: input.expires_at - nowSeconds };
  }
  return { expires_at: null, ttl_seconds: null };
}

export class ScratchpadStore {
  constructor(private readonly sqlite: Database) {}

  /** Most recently updated first; list items omit content. */
  list(query: ScratchpadListQuery = {}): ScratchpadListItem[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.kind) {
      where.push("kind=?");
      params.push(query.kind);
    }
    if (query.project_id === null) where.push("project_id IS NULL");
    else if (query.project_id) {
      where.push(query.include_global ? "(project_id=? OR project_id IS NULL)" : "project_id=?");
      params.push(query.project_id);
    }
    if (query.session_id) {
      where.push("session_id=?");
      params.push(query.session_id);
    }
    if (query.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(scratchpads.tags) WHERE value=?)");
      params.push(normalizeTags([query.tag])[0] ?? query.tag);
    }
    if (query.q?.trim()) {
      const like = `%${query.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    if (query.expiry === "expiring") {
      // Due within two days, still active. Archived pads belong to the expired filter.
      where.push(
        "archived_at IS NULL AND expires_at IS NOT NULL AND expires_at > unixepoch() AND expires_at <= unixepoch() + 172800",
      );
    } else if (query.expiry === "expired") {
      where.push("archived_at IS NOT NULL");
    }
    if (query.pinned !== undefined) {
      where.push("pinned=?");
      params.push(query.pinned ? 1 : 0);
    }
    return this.sqlite
      .query<ListRow, (string | number)[]>(
        `SELECT id,kind,title,project_id,session_id,tags,author,revision,created_at,updated_at,
           archived_at,delete_after,expires_at,ttl_seconds,pinned,keep_alive,expiry_skipped_reason,
           length(CAST(content AS BLOB)) AS size_bytes
         FROM scratchpads ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(...params)
      .map(parse);
  }

  get(id: string): Scratchpad {
    const row = this.sqlite
      .query<Row, [string]>(
        `SELECT id,kind,title,content,project_id,session_id,tags,author,revision,created_at,
           updated_at,archived_at,delete_after,expires_at,ttl_seconds,pinned,keep_alive,
           expiry_skipped_reason
         FROM scratchpads WHERE id=?`,
      )
      .get(id);
    if (!row) throw new NotFoundError("Scratchpad", id);
    return parse(row);
  }

  create(input: ScratchpadCreate, now = new Date()): Scratchpad {
    const content = input.content ?? emptyScratchpadContent(input.kind);
    validateScratchpadContent(input.kind, content);
    const expiry = resolveExpiry(input, now) ?? { expires_at: null, ttl_seconds: null };
    const id = ulid();
    this.sqlite
      .transaction(() => {
        if (input.project_id) this.requireProject(input.project_id);
        this.sqlite
          .query(
            `INSERT INTO scratchpads(
               id,kind,title,content,project_id,session_id,tags,author,
               expires_at,ttl_seconds,pinned,keep_alive
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            input.kind,
            input.title.trim(),
            content,
            input.project_id ?? null,
            input.session_id ?? null,
            tagsColumn(input.tags),
            input.author ?? "human",
            expiry.expires_at,
            expiry.ttl_seconds,
            input.pinned ? 1 : 0,
            input.keep_alive ? 1 : 0,
          );
      })
      .immediate();
    return this.get(id);
  }

  /**
   * The pad, or a 409 when its file has changed since `ifRevision`. Title, tag and project edits
   * leave the file alone, so a revision from before them still holds for the file.
   */
  at(id: string, ifRevision?: number): Scratchpad {
    return this.check(id, ifRevision, "file");
  }

  /**
   * Every write bumps the revision; `if_revision` turns a stale write into a 409. A write of the
   * file alone conflicts only with another file change, so a concurrent rename does not refuse it.
   * `keep_alive` pads slide their expiry forward on an edit that is not an explicit expiry change.
   */
  update(id: string, input: ScratchpadUpdate, now = new Date()): Scratchpad {
    const fileOnly =
      input.title === undefined &&
      input.project_id === undefined &&
      input.session_id === undefined &&
      input.tags === undefined &&
      input.ttl === undefined &&
      input.expires_at === undefined &&
      input.pinned === undefined &&
      input.keep_alive === undefined;
    this.sqlite
      .transaction(() => {
        const before = this.check(id, input.if_revision, fileOnly ? "file" : "pad");
        if (input.content !== undefined) validateScratchpadContent(before.kind, input.content);
        if (input.project_id) this.requireProject(input.project_id);
        const fileChanged = input.content !== undefined && input.content !== before.content;
        const expiry = resolveExpiry(input, now);
        const keepAlive = input.keep_alive ?? before.keep_alive;
        const edited =
          input.content !== undefined ||
          input.title !== undefined ||
          input.tags !== undefined ||
          input.project_id !== undefined ||
          input.session_id !== undefined;
        let expiresAt = expiry ? expiry.expires_at : before.expires_at;
        const ttlSeconds = expiry ? expiry.ttl_seconds : before.ttl_seconds;
        // An explicit ttl/expires_at wins; otherwise a keep-alive edit restarts the window.
        if (!expiry && edited && keepAlive && expiresAt !== null && ttlSeconds !== null)
          expiresAt = Math.floor(now.getTime() / 1000) + ttlSeconds;
        this.sqlite
          .query(
            `UPDATE scratchpads SET title=?,content=?,project_id=?,session_id=?,tags=?,author=?,
               revision=revision+1,
               content_revision=CASE WHEN ? THEN revision+1 ELSE content_revision END,
               updated_at=unixepoch(),
               expires_at=?,ttl_seconds=?,pinned=?,keep_alive=?,expiry_skipped_reason=?
             WHERE id=?`,
          )
          .run(
            input.title?.trim() ?? before.title,
            input.content ?? before.content,
            input.project_id === undefined ? before.project_id : input.project_id,
            input.session_id === undefined ? before.session_id : input.session_id,
            input.tags === undefined ? tagsColumn(before.tags) : tagsColumn(input.tags),
            input.author ?? "human",
            fileChanged ? 1 : 0,
            expiresAt,
            ttlSeconds,
            (input.pinned ?? before.pinned) ? 1 : 0,
            keepAlive ? 1 : 0,
            expiry === null ? before.expiry_skipped_reason : null,
            id,
          );
      })
      .immediate();
    return this.get(id);
  }

  /**
   * Archives pads whose expiry is due, scheduling their purge after the grace
   * period. Pinned pads are left alone; a pad referenced by another pad, task,
   * comment, knowledge-base document or memory keeps its content and has its
   * expiry cleared with a reason, so it is not retried on every sweep.
   */
  expireDue(now = new Date(), graceDays = 7): ScratchpadExpiryOutcome {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const graceSeconds = Math.max(1, Math.floor(graceDays)) * 86_400;
    // One transaction: a concurrent restore or edit must not be re-archived from
    // a due-list read before it ran.
    return this.sqlite
      .transaction(() => {
        const due = this.sqlite
          .query<{ id: string; pinned: number }, [number]>(
            `SELECT id,pinned FROM scratchpads
             WHERE archived_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?
             ORDER BY expires_at`,
          )
          .all(nowSeconds);
        const skipped: { id: string; reason: string }[] = [];
        let archived = 0;
        for (const row of due) {
          if (row.pinned === 1) {
            this.sqlite
              .query(
                "UPDATE scratchpads SET expiry_skipped_reason='pinned' WHERE id=? AND (expiry_skipped_reason IS NULL OR expiry_skipped_reason<>'pinned')",
              )
              .run(row.id);
            continue;
          }
          const reason = this.referenceReason(row.id);
          if (reason) {
            this.sqlite
              .query(
                "UPDATE scratchpads SET expires_at=NULL,ttl_seconds=NULL,expiry_skipped_reason=? WHERE id=?",
              )
              .run(reason, row.id);
            skipped.push({ id: row.id, reason });
            continue;
          }
          this.sqlite
            .query(
              "UPDATE scratchpads SET archived_at=?,delete_after=?,expires_at=NULL,expiry_skipped_reason=NULL WHERE id=?",
            )
            .run(nowSeconds, nowSeconds + graceSeconds, row.id);
          archived++;
        }
        return { archived, skipped };
      })
      .immediate();
  }

  /**
   * Recoverable delete: the pad stays readable and listed with its deadline until
   * the maintenance sweep purges it. ttlDays 0 purges immediately and returns null.
   */
  delete(id: string, ttlDays: number, now = new Date()): Scratchpad | null {
    this.get(id);
    if (ttlDays === 0) {
      this.purge(id);
      return null;
    }
    scheduleTtl(this.sqlite, { table: "scratchpads", id, ttlDays, now });
    return this.get(id);
  }

  /** Cancels a scheduled delete and clears the archive marker and any expiry. */
  restore(id: string): Scratchpad {
    this.get(id);
    restoreTtl(this.sqlite, {
      table: "scratchpads",
      id,
      extra: { expires_at: null, ttl_seconds: null, expiry_skipped_reason: null },
    });
    return this.get(id);
  }

  /** Permanent removal, called by an immediate delete and the TTL sweep. */
  purge(id: string): void {
    const { changes } = this.sqlite.query("DELETE FROM scratchpads WHERE id=?").run(id);
    if (!changes) throw new NotFoundError("Scratchpad", id);
  }

  private check(id: string, ifRevision: number | undefined, scope: "file" | "pad"): Scratchpad {
    const pad = this.get(id);
    if (ifRevision === undefined) return pad;
    const revisions = this.sqlite
      .query<Revisions, [string]>("SELECT revision,content_revision FROM scratchpads WHERE id=?")
      .get(id) as Revisions;
    const since = scope === "file" ? revisions.content_revision : revisions.revision;
    if (ifRevision < since || ifRevision > revisions.revision)
      throw new ConflictError(
        `Scratchpad changed: revision ${pad.revision} by ${pad.author}, expected ${ifRevision}`,
      );
    return pad;
  }

  /**
   * A pad id is a ULID, so an occurrence in any stored text is a reliable reference.
   * Skill files live on disk and are not scanned here.
   */
  private referenceReason(id: string): string | null {
    const checks: {
      table: string;
      column: string;
      label: string;
      excludeSelf?: boolean;
    }[] = [
      { table: "scratchpads", column: "content", label: "another pad", excludeSelf: true },
      { table: "tasks", column: "body", label: "a task" },
      { table: "comments", column: "content", label: "a comment" },
      { table: "kb_documents", column: "content", label: "a knowledge base document" },
      { table: "memories", column: "content", label: "a memory" },
    ];
    for (const check of checks) {
      if (
        !this.sqlite
          .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(check.table)
      )
        continue;
      const sql = `SELECT 1 FROM ${check.table} WHERE instr(COALESCE(${check.column}, ''), ?) > 0${check.excludeSelf ? " AND id<>?" : ""} LIMIT 1`;
      const row = check.excludeSelf
        ? this.sqlite.query(sql).get(id, id)
        : this.sqlite.query(sql).get(id);
      if (row) return `referenced by ${check.label}`;
    }
    return null;
  }

  private requireProject(projectId: string): void {
    if (!this.sqlite.query("SELECT 1 FROM projects WHERE id=?").get(projectId))
      throw new NotFoundError("Project", projectId);
  }
}
