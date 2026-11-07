import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { ChannelConnection, ChannelTarget } from "@orc/core/channels";
import { loadConfig } from "@orc/core/config";
import {
  type NotificationDelivery,
  type NotificationForwardingPolicy,
  NotificationForwardingPolicySchema,
  NotificationSchema,
  notificationMatches,
  type OrcNotification,
} from "@orc/core/notifications";
import { z } from "zod";
import { NotificationStore } from "./notifications.js";

export type DeliveryClaim = NotificationDelivery & {
  destination: string;
  owner: string;
  lease_until: number;
  idempotency_key: string;
};
type ClaimRow = Omit<DeliveryClaim, "idempotency_key">;
export function installNotificationReceiptPins(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS notification_receipt_pins (
    connection TEXT NOT NULL,idem TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(connection,idem))`);
}
type Destination = { connection: string; target: string; fingerprint: string; since: number };
export function notificationDestination(
  connection: ChannelConnection,
  target: ChannelTarget,
): string {
  return JSON.stringify([connection.provider, target.chat_id, target.thread_id ?? null]);
}

export class NotificationDeliveryStore {
  constructor(
    readonly db: Database,
    readonly now: () => number = Date.now,
  ) {
    installNotificationReceiptPins(db);
    new NotificationStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS notification_forwarding_policy (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, since INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_destinations (connection TEXT NOT NULL,target TEXT NOT NULL,fingerprint TEXT NOT NULL,since INTEGER NOT NULL,PRIMARY KEY(connection,target));
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        notification_id TEXT NOT NULL,connection_id TEXT NOT NULL,target_id TEXT NOT NULL,destination TEXT NOT NULL,
        status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,
        error TEXT,receipt_id TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        owner TEXT NOT NULL DEFAULT '',lease_until INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(notification_id,connection_id,target_id));
      CREATE INDEX IF NOT EXISTS notification_deliveries_due ON notification_deliveries(status,next_at);`);
  }
  policy(): NotificationForwardingPolicy {
    const row = this.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM notification_forwarding_policy WHERE id=1",
      )
      .get();
    return NotificationForwardingPolicySchema.parse(row ? JSON.parse(row.payload) : {});
  }
  savePolicy(raw: unknown): NotificationForwardingPolicy {
    const policy = NotificationForwardingPolicySchema.parse(raw);
    const previous = this.policy();
    this.db
      .query(`INSERT INTO notification_forwarding_policy VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,
      since=CASE WHEN ? THEN excluded.since ELSE notification_forwarding_policy.since END`)
      .run(
        JSON.stringify(policy),
        this.now(),
        Number(!previous.enabled || previous.base_url !== policy.base_url),
      );
    return policy;
  }
  syncDestinations(connections: readonly ChannelConnection[]): void {
    const live = new Set<string>();
    for (const connection of connections)
      for (const target of connection.targets) {
        if (!connection.enabled || !target.outbound || !target.notifications?.enabled) continue;
        live.add(JSON.stringify([connection.id, target.id]));
        const fingerprint = JSON.stringify([
          notificationDestination(connection, target),
          target.project_ids,
          target.notifications,
        ]);
        this.db
          .query(`INSERT INTO notification_destinations VALUES(?,?,?,?) ON CONFLICT(connection,target) DO UPDATE SET
        fingerprint=excluded.fingerprint,since=excluded.since WHERE fingerprint<>excluded.fingerprint`)
          .run(connection.id, target.id, fingerprint, this.now());
      }
    for (const row of this.db
      .query<Destination, []>("SELECT * FROM notification_destinations")
      .all())
      if (!live.has(JSON.stringify([row.connection, row.target])))
        this.db
          .query("DELETE FROM notification_destinations WHERE connection=? AND target=?")
          .run(row.connection, row.target);
  }
  enqueue(connections: readonly ChannelConnection[]): void {
    this.syncDestinations(connections);
    this.db
      .query(
        "DELETE FROM notification_receipt_pins WHERE rowid IN (SELECT rowid FROM notification_receipt_pins WHERE expires_at<=? LIMIT 1000)",
      )
      .run(this.now());
    this.db
      .query(`DELETE FROM notification_deliveries WHERE rowid IN (SELECT d.rowid FROM notification_deliveries d
      WHERE d.expires_at<=? OR NOT EXISTS(SELECT 1 FROM notifications n WHERE n.id=d.notification_id) LIMIT 1000)`)
      .run(this.now());
    if (!this.policy().enabled) return;
    const since =
      this.db
        .query<{ since: number }, []>("SELECT since FROM notification_forwarding_policy WHERE id=1")
        .get()?.since ?? this.now();
    let budget = 200;
    for (const destination of this.db
      .query<Destination, []>("SELECT * FROM notification_destinations")
      .all()) {
      if (budget <= 0) break;
      const connection = connections.find((value) => value.id === destination.connection);
      const target = connection?.targets.find((value) => value.id === destination.target);
      if (!connection || !target?.notifications) continue;
      const events = this.db
        .query<
          { id: string },
          [number, number, number, string, string, number]
        >(`SELECT n.id FROM notifications n
        WHERE n.created_at>=? AND n.expires_at>? AND n.created_at>? AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries d WHERE d.notification_id=n.id AND d.connection_id=? AND d.target_id=?)
        ORDER BY n.created_at,n.id LIMIT ?`)
        .all(
          Math.max(since, destination.since),
          this.now(),
          this.cutoff(),
          connection.id,
          target.id,
          Math.min(100, budget),
        );
      for (const row of events) {
        const event = this.event(row.id);
        if (!event) continue;
        const matches = notificationMatches(event, target.notifications, target.project_ids);
        this.db
          .query(`INSERT OR IGNORE INTO notification_deliveries
          (notification_id,connection_id,target_id,destination,status,next_at,created_at,expires_at)
          VALUES(?,?,?,?,?,?,?,?)`)
          .run(
            event.id,
            connection.id,
            target.id,
            notificationDestination(connection, target),
            matches ? "pending" : "skipped",
            this.now(),
            this.now(),
            event.expires_at,
          );
        budget--;
      }
    }
  }
  event(id: string): OrcNotification | null {
    const row = this.db
      .query<Record<string, unknown>, [string, number, number]>(
        "SELECT * FROM notifications WHERE id=? AND expires_at>? AND created_at>?",
      )
      .get(id, this.now(), this.cutoff());
    if (!row) return null;
    return NotificationSchema.parse({ ...row, requires_action: !!row.requires_action });
  }
  list(limit = 50): NotificationDelivery[] {
    z.number().int().min(1).max(100).parse(limit);
    return this.db
      .query<
        NotificationDelivery,
        [number]
      >(`SELECT notification_id,connection_id,target_id,status,attempts,next_at,error,receipt_id,created_at,expires_at
      FROM notification_deliveries WHERE status<>'skipped' OR error IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT ?`)
      .all(limit);
  }
  startsAt(connection: string, target: string): number {
    const destination = this.db
      .query<{ since: number }, [string, string]>(
        "SELECT since FROM notification_destinations WHERE connection=? AND target=?",
      )
      .get(connection, target);
    const policy = this.db
      .query<{ since: number }, []>("SELECT since FROM notification_forwarding_policy WHERE id=1")
      .get();
    return destination && policy
      ? Math.max(destination.since, policy.since)
      : Number.POSITIVE_INFINITY;
  }
  claim(owner: string): DeliveryClaim | null {
    const now = this.now();
    return this.db
      .transaction(() => {
        const row = this.db
          .query<ClaimRow, [number, number]>(`SELECT * FROM notification_deliveries
        WHERE (status='pending' AND next_at<=?) OR (status='sending' AND lease_until<=?) ORDER BY next_at LIMIT 1`)
          .get(now, now);
        if (!row) return null;
        const claim = this.db
          .query<
            ClaimRow,
            [string, number, string, string, string]
          >(`UPDATE notification_deliveries SET status='sending',owner=?,lease_until=?,
        attempts=attempts+CASE WHEN status='pending' THEN 1 ELSE 0 END WHERE notification_id=? AND connection_id=? AND target_id=? RETURNING *`)
          .get(owner, now + 120000, row.notification_id, row.connection_id, row.target_id);
        if (!claim) return null;
        const hash = createHash("sha256")
          .update(JSON.stringify([claim.notification_id, claim.connection_id, claim.target_id]))
          .digest("hex");
        const key = `notification:${hash}:${claim.attempts}`;
        // Keep reconciliation evidence even when normal channel receipt retention is shorter.
        this.db
          .query("INSERT OR REPLACE INTO notification_receipt_pins VALUES(?,?,?)")
          .run(claim.connection_id, key, claim.expires_at);
        return { ...claim, idempotency_key: key };
      })
      .immediate();
  }
  finish(
    claim: DeliveryClaim,
    status: NotificationDelivery["status"],
    error: string | null,
    receiptId: string | null = null,
  ): void {
    this.db
      .query(`UPDATE notification_deliveries SET status=?,error=?,receipt_id=?,next_at=?,lease_until=0
      WHERE notification_id=? AND connection_id=? AND target_id=? AND owner=? AND lease_until=? AND status='sending'`)
      .run(
        status,
        error,
        receiptId,
        this.now() + Math.min(60000, 2000 * 2 ** claim.attempts),
        claim.notification_id,
        claim.connection_id,
        claim.target_id,
        claim.owner,
        claim.lease_until,
      );
  }
  private cutoff(): number {
    return this.now() - (loadConfig().preferences.notification_retention_days ?? 30) * 86400000;
  }
}
