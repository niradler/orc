import type { Database } from "bun:sqlite";
import { NotFoundError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import {
  PUSH_TOPICS,
  type PushDevice,
  type PushSubscriptionInput,
  type PushTopic,
  PushTopicSchema,
} from "@orc/core/push";

export type VapidKeys = { publicKey: string; privateKey: string };
export type PushTarget = {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

type DeviceRow = {
  id: string;
  endpoint: string;
  label: string;
  topics: string;
  created_at: number;
  last_success_at: number | null;
  failure_count: number;
};

function toDevice(row: DeviceRow): PushDevice {
  return {
    id: row.id,
    label: row.label,
    endpoint_host: new URL(row.endpoint).hostname,
    topics: PushTopicSchema.array().parse(JSON.parse(row.topics)),
    created_at: row.created_at,
    last_success_at: row.last_success_at,
    failure_count: row.failure_count,
  };
}

/** Browser push devices and the server's VAPID identity. */
export class PushStore {
  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      label TEXT NOT NULL, topics TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_success_at INTEGER, failure_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS push_vapid_keys (
      id INTEGER PRIMARY KEY CHECK (id = 1), public_key TEXT NOT NULL, private_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  }

  /** Returns the persisted key pair, creating it once. */
  vapidKeys(generate: () => VapidKeys): VapidKeys {
    const select = () =>
      this.db
        .query<{ public_key: string; private_key: string }, []>(
          "SELECT public_key, private_key FROM push_vapid_keys WHERE id = 1",
        )
        .get();
    const existing = select();
    if (existing) return { publicKey: existing.public_key, privateKey: existing.private_key };
    const created = generate();
    this.db
      .query(
        "INSERT OR IGNORE INTO push_vapid_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)",
      )
      .run(created.publicKey, created.privateKey, this.now());
    const stored = select();
    if (!stored) throw new Error("VAPID keys could not be stored");
    return { publicKey: stored.public_key, privateKey: stored.private_key };
  }

  /** Registers a device, or refreshes it when the browser re-subscribes with the same endpoint. */
  subscribe(input: PushSubscriptionInput): PushDevice {
    const chosen = input.topics ? JSON.stringify([...new Set(input.topics)]) : null;
    const row = this.db
      .query<DeviceRow, [string, string, string, string, string, string, number, string | null]>(
        `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, topics, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
          label = excluded.label, topics = COALESCE(?8, push_subscriptions.topics), failure_count = 0
        RETURNING id, endpoint, label, topics, created_at, last_success_at, failure_count`,
      )
      .get(
        ulid(),
        input.endpoint,
        input.keys.p256dh,
        input.keys.auth,
        input.label,
        chosen ?? JSON.stringify(PUSH_TOPICS),
        this.now(),
        chosen,
      );
    if (!row) throw new Error("Push subscription could not be stored");
    return toDevice(row);
  }

  list(): PushDevice[] {
    return this.db
      .query<DeviceRow, []>(
        "SELECT id, endpoint, label, topics, created_at, last_success_at, failure_count FROM push_subscriptions ORDER BY created_at",
      )
      .all()
      .map(toDevice);
  }

  get(id: string): PushDevice {
    const row = this.db
      .query<DeviceRow, [string]>(
        "SELECT id, endpoint, label, topics, created_at, last_success_at, failure_count FROM push_subscriptions WHERE id = ?",
      )
      .get(id);
    if (!row) throw new NotFoundError("Push device", id);
    return toDevice(row);
  }

  updateTopics(id: string, topics: PushTopic[]): PushDevice {
    const changed = this.db
      .query("UPDATE push_subscriptions SET topics = ? WHERE id = ?")
      .run(JSON.stringify([...new Set(topics)]), id).changes;
    if (!changed) throw new NotFoundError("Push device", id);
    return this.get(id);
  }

  remove(id: string): void {
    const changed = this.db.query("DELETE FROM push_subscriptions WHERE id = ?").run(id).changes;
    if (!changed) throw new NotFoundError("Push device", id);
  }

  /** Devices that opted into a topic, or one device when `id` is given. */
  targets(topic: PushTopic | null, id?: string): PushTarget[] {
    const rows = this.db
      .query<{ id: string; endpoint: string; p256dh: string; auth: string; topics: string }, []>(
        "SELECT id, endpoint, p256dh, auth, topics FROM push_subscriptions",
      )
      .all();
    return rows
      .filter((row) => (id ? row.id === id : true))
      .filter((row) => topic === null || (JSON.parse(row.topics) as string[]).includes(topic))
      .map((row) => ({
        id: row.id,
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      }));
  }

  markDelivered(id: string): void {
    this.db
      .query("UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE id = ?")
      .run(this.now(), id);
  }

  markFailed(id: string): void {
    this.db
      .query("UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?")
      .run(id);
  }

  /** The push service reported the subscription gone (404/410); it can never succeed again. */
  expire(id: string): void {
    this.db.query("DELETE FROM push_subscriptions WHERE id = ?").run(id);
  }
}
