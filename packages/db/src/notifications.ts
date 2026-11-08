import type { Database } from "bun:sqlite";
import { loadConfig } from "@orc/core/config";
import { NotFoundError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import {
  type NotificationInput,
  NotificationInputSchema,
  type NotificationPage,
  NotificationSchema,
  type NotificationUpdate,
  NotificationUpdateSchema,
  type OrcNotification,
} from "@orc/core/notifications";
import { z } from "zod";
import { AuditLog, installAudit, recordNotificationAudit } from "./audit.js";

type Row = Omit<OrcNotification, "requires_action"> & { requires_action: number };
const ID_ATTEMPTS = 8;
const COLUMNS =
  "id,type,source_id,title,body,level,project_id,path,requires_action,created_at,expires_at,read_at,dismissed_at";
const notification = (row: Row, maximumAge: number): OrcNotification =>
  NotificationSchema.parse({
    ...row,
    expires_at: Math.min(row.expires_at, row.created_at + maximumAge),
    requires_action: !!row.requires_action,
  });

/** A producer owns source_key; reading and delivery never manufacture another event. */
export class NotificationStore {
  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly retentionDays: () => number = () =>
      loadConfig().preferences.notification_retention_days ?? 30,
    private readonly generateId: () => string = ulid,
  ) {
    installAudit(db);
    db.exec(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
      source_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      level TEXT NOT NULL, project_id TEXT, path TEXT NOT NULL,
      requires_action INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      read_at INTEGER, dismissed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS notifications_created ON notifications(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS notifications_expiry ON notifications(expires_at);`);
  }

  publish(raw: NotificationInput): OrcNotification | null {
    const input = NotificationInputSchema.parse(raw);
    const maximumAge = this.maximumAge();
    const now = this.now();
    input.expires_at = Math.min(input.expires_at, input.created_at + maximumAge);
    if (input.expires_at <= now) return null;
    return this.db
      .transaction(() => {
        const source = this.db.query<Row, [string]>(
          `SELECT ${COLUMNS} FROM notifications WHERE source_key=?`,
        );
        const existing = source.get(input.source_key);
        if (existing)
          return existing.expires_at > now && existing.created_at > now - maximumAge
            ? notification(existing, maximumAge)
            : null;
        const insert = this.db.query(`INSERT INTO notifications
      (id,source_key,type,source_id,title,body,level,project_id,path,requires_action,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO NOTHING`);
        for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
          const id = this.generateId();
          let inserted: number;
          try {
            inserted = insert.run(
              id,
              input.source_key,
              input.type,
              input.source_id,
              input.title,
              input.body,
              input.level,
              input.project_id,
              input.path,
              Number(input.requires_action),
              input.created_at,
              input.expires_at,
            ).changes;
          } catch (error) {
            if (
              attempt === ID_ATTEMPTS - 1 ||
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "SQLITE_CONSTRAINT_PRIMARYKEY" ||
              !this.db
                .query<{ id: string }, [string]>("SELECT id FROM notifications WHERE id=?")
                .get(id)
            )
              throw error;
            continue;
          }
          const row = source.get(input.source_key);
          if (!row || row.expires_at <= now || row.created_at <= now - maximumAge) return null;
          const item = notification(row, maximumAge);
          if (inserted)
            recordNotificationAudit(this.db, "notification.created", item, { now: () => now });
          return item;
        }
        throw new Error("Notification ID allocation exhausted");
      })
      .immediate();
  }

  resolve(sourceKey: string): void {
    z.string().min(1).max(500).parse(sourceKey);
    this.resolveWhere("source_key=?", [sourceKey]);
  }

  resolveSource(type: string, sourceId: string): void {
    z.string().min(1).max(100).parse(type);
    z.string().min(1).max(256).parse(sourceId);
    this.resolveWhere("type=? AND source_id=?", [type, sourceId]);
  }

  list(limit = 50, offset = 0, unreadOnly = false): NotificationPage {
    z.number().int().min(1).max(100).parse(limit);
    z.number().int().min(0).max(1000000).parse(offset);
    z.boolean().parse(unreadOnly);
    this.cleanup();
    const maximumAge = this.maximumAge();
    const cutoff = this.now() - maximumAge;
    const filter = `expires_at>? AND created_at>? AND dismissed_at IS NULL${unreadOnly ? " AND read_at IS NULL" : ""}`;
    const rows = this.db
      .query<Row, [number, number, number, number]>(
        `SELECT ${COLUMNS} FROM notifications WHERE ${filter} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(this.now(), cutoff, limit + 1, offset);
    const unread =
      this.db
        .query<{ count: number }, [number, number]>(
          "SELECT count(*) AS count FROM notifications WHERE expires_at>? AND created_at>? AND dismissed_at IS NULL AND read_at IS NULL",
        )
        .get(this.now(), cutoff)?.count ?? 0;
    return {
      notifications: rows.slice(0, limit).map((row) => notification(row, maximumAge)),
      unread,
      has_more: rows.length > limit,
    };
  }

  update(id: string, raw: NotificationUpdate): OrcNotification {
    z.string().min(1).max(100).parse(id);
    const update = NotificationUpdateSchema.parse(raw);
    const now = this.now();
    const maximumAge = this.maximumAge();
    return this.db
      .transaction(() => {
        const before = this.db
          .query<Row, [string, number, number]>(
            `SELECT ${COLUMNS} FROM notifications WHERE id=? AND expires_at>? AND created_at>?`,
          )
          .get(id, now, now - maximumAge);
        if (!before) throw new NotFoundError("Notification", id);
        const result = this.db
          .query<
            Row,
            [
              number,
              number | null,
              number | null,
              number,
              number | null,
              number | null,
              string,
              number,
              number,
            ]
          >(
            `UPDATE notifications SET read_at=CASE WHEN ? THEN CASE WHEN ? IS NULL THEN NULL ELSE coalesce(read_at,?) END ELSE read_at END,
         dismissed_at=CASE WHEN ? THEN CASE WHEN ? IS NULL THEN NULL ELSE coalesce(dismissed_at,?) END ELSE dismissed_at END WHERE id=? AND expires_at>? AND created_at>?
         RETURNING ${COLUMNS}`,
          )
          .get(
            Number(update.read !== undefined),
            update.read ? now : null,
            update.read ? now : null,
            Number(update.dismissed !== undefined),
            update.dismissed ? now : null,
            update.dismissed ? now : null,
            id,
            now,
            now - maximumAge,
          );
        if (!result) throw new NotFoundError("Notification", id);
        const item = notification(result, maximumAge);
        if ((before.read_at === null) !== (result.read_at === null))
          recordNotificationAudit(
            this.db,
            result.read_at === null ? "notification.unread" : "notification.read",
            item,
            { now: () => now },
          );
        if ((before.dismissed_at === null) !== (result.dismissed_at === null))
          recordNotificationAudit(
            this.db,
            result.dismissed_at === null ? "notification.restored" : "notification.dismissed",
            item,
            { now: () => now },
          );
        return item;
      })
      .immediate();
  }

  markAllRead(): void {
    const now = this.now();
    const cutoff = now - this.maximumAge();
    this.db
      .transaction(() => {
        const updated = this.db
          .query(
            "UPDATE notifications SET read_at=? WHERE read_at IS NULL AND dismissed_at IS NULL AND expires_at>? AND created_at>?",
          )
          .run(now, now, cutoff);
        if (updated.changes)
          new AuditLog(this.db, { now: () => now }).record({
            action: "notification.read_all",
            subject_ids: [],
            snapshot: { count: updated.changes },
          });
      })
      .immediate();
  }

  markFinishedRead(sourceId: string): number {
    z.string().min(1).max(256).parse(sourceId);
    const now = this.now();
    return this.db
      .transaction(() => {
        const rows = this.db
          .query<Row, [number, string, number, number]>(
            `UPDATE notifications SET read_at=? WHERE source_id=? AND type='agent.finished'
             AND read_at IS NULL AND dismissed_at IS NULL AND expires_at>? AND created_at>?
             RETURNING ${COLUMNS}`,
          )
          .all(now, sourceId, now, now - this.maximumAge());
        for (const row of rows)
          recordNotificationAudit(
            this.db,
            "notification.read",
            notification(row, this.maximumAge()),
            {
              now: () => now,
            },
          );
        return rows.length;
      })
      .immediate();
  }

  cleanup(batchSize = 1000): number {
    z.number().int().min(1).max(10000).parse(batchSize);
    const maximumAge = this.maximumAge();
    const now = this.now();
    return this.db
      .transaction(() => {
        this.db
          .query(
            "UPDATE notifications SET expires_at=created_at+? WHERE id IN (SELECT id FROM notifications WHERE expires_at>created_at+? LIMIT ?)",
          )
          .run(maximumAge, maximumAge, batchSize);
        const expired = this.db
          .query<Row, [number, number]>(
            `DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE expires_at<=? ORDER BY expires_at LIMIT ?) RETURNING ${COLUMNS}`,
          )
          .all(now, batchSize);
        for (const row of expired)
          recordNotificationAudit(this.db, "notification.expired", row, { now: () => now });
        return expired.length;
      })
      .immediate();
  }

  private resolveWhere(predicate: string, bindings: string[]): void {
    const now = this.now();
    const maximumAge = this.maximumAge();
    this.db
      .transaction(() => {
        const rows = this.db
          .query<Row, (string | number)[]>(
            `UPDATE notifications SET requires_action=0 WHERE ${predicate} AND requires_action=1 AND expires_at>? AND created_at>? RETURNING ${COLUMNS}`,
          )
          .all(...bindings, now, now - maximumAge);
        for (const row of rows)
          recordNotificationAudit(this.db, "notification.resolved", notification(row, maximumAge), {
            now: () => now,
          });
      })
      .immediate();
  }

  private maximumAge(): number {
    return z.number().int().min(1).max(3650).parse(this.retentionDays()) * 86400000;
  }
}
