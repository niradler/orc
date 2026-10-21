import type { Database } from "bun:sqlite";

const sources = `CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE, secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]', actions TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)`;
const deliveries = `CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  delivery_key TEXT NOT NULL, event TEXT NOT NULL, action TEXT, repository TEXT, payload_hash TEXT NOT NULL,
  status TEXT NOT NULL, job_run_id TEXT REFERENCES job_runs(id) ON DELETE SET NULL, error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(webhook_id, delivery_key)
)`;
const subscriptions = `CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  events TEXT NOT NULL DEFAULT '[]', actions TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(webhook_id, job_id)
)`;

export function installReusableWebhooks(sqlite: Database): void {
  const columns = sqlite
    .query<{ name: string; notnull: number }, []>("PRAGMA table_info(webhooks)")
    .all();
  if (columns.some((column) => column.name === "job_id" && column.notnull === 1)) {
    sqlite.transaction(() => {
      // Preserve originals for recovery; runtime only reads the new tables.
      sqlite.exec("ALTER TABLE webhook_deliveries RENAME TO webhook_deliveries_legacy_single_job");
      sqlite.exec("ALTER TABLE webhooks RENAME TO webhooks_legacy_single_job");
      sqlite.exec(sources);
      sqlite.exec(deliveries);
      sqlite.exec(subscriptions);
      sqlite.exec(`INSERT INTO webhooks(id,name,provider,project_id,token,secret,events,actions,enabled,created_at,updated_at)
        SELECT h.id,h.name,h.provider,j.project_id,h.token,h.secret,h.events,h.actions,h.enabled,h.created_at,h.updated_at
        FROM webhooks_legacy_single_job h LEFT JOIN jobs j ON j.id=h.job_id`);
      sqlite.exec(`INSERT INTO webhook_subscriptions(webhook_id,job_id,events,actions)
        SELECT id,job_id,events,actions FROM webhooks_legacy_single_job WHERE job_id IN (SELECT id FROM jobs)`);
      sqlite.exec(
        "INSERT INTO webhook_deliveries SELECT * FROM webhook_deliveries_legacy_single_job",
      );
    })();
  } else {
    sqlite.exec(sources);
    sqlite.exec(deliveries);
    sqlite.exec(subscriptions);
  }
  sqlite.exec(`CREATE INDEX IF NOT EXISTS webhook_deliveries_source_idx ON webhook_deliveries(webhook_id,created_at);
    CREATE TABLE IF NOT EXISTS webhook_delivery_runs (
      delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      job_run_id TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
      PRIMARY KEY(delivery_id,job_id)
    );
    INSERT OR IGNORE INTO webhook_delivery_runs(delivery_id,job_id,job_run_id)
      SELECT d.id,r.job_id,r.id FROM webhook_deliveries d INNER JOIN job_runs r ON r.id=d.job_run_id;`);
}
