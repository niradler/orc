import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { installReusableWebhooks } from "./reusable-webhooks.js";

test("should preserve legacy endpoint identity, secrets, filters and history while removing job ownership", () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE projects(id TEXT PRIMARY KEY);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id));
    CREATE TABLE job_runs(id TEXT PRIMARY KEY,job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE);
    CREATE TABLE webhooks(id TEXT PRIMARY KEY,name TEXT NOT NULL,provider TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,token TEXT NOT NULL UNIQUE,secret TEXT NOT NULL,
      events TEXT NOT NULL,actions TEXT NOT NULL,enabled INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE webhook_deliveries(id TEXT PRIMARY KEY,webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      delivery_key TEXT NOT NULL,event TEXT NOT NULL,action TEXT,repository TEXT,payload_hash TEXT NOT NULL,status TEXT NOT NULL,
      job_run_id TEXT REFERENCES job_runs(id) ON DELETE SET NULL,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(webhook_id,delivery_key));
    INSERT INTO projects VALUES('project');
    INSERT INTO jobs VALUES('job','project');
    INSERT INTO job_runs VALUES('run','job');
    INSERT INTO webhooks VALUES('hook','GitHub','github','job','original-token','encrypted-secret','["push"]','[]',1,10,20);
    INSERT INTO webhook_deliveries VALUES('delivery','hook','unique','push',NULL,'repo','hash','success','run',NULL,10,20);`);
  try {
    installReusableWebhooks(sqlite);
    installReusableWebhooks(sqlite);
    expect(sqlite.query("SELECT token,secret,project_id,job_id FROM webhooks").get()).toEqual({
      token: "original-token",
      secret: "encrypted-secret",
      project_id: "project",
      job_id: null,
    });
    expect(sqlite.query("SELECT * FROM webhook_subscriptions").all()).toEqual([
      { webhook_id: "hook", job_id: "job", events: '["push"]', actions: "[]" },
    ]);
    expect(sqlite.query("SELECT payload_hash,job_run_id FROM webhook_deliveries").get()).toEqual({
      payload_hash: "hash",
      job_run_id: "run",
    });
    expect(sqlite.query("SELECT * FROM webhook_delivery_runs").all()).toEqual([
      { delivery_id: "delivery", job_id: "job", job_run_id: "run" },
    ]);
    sqlite.query("DELETE FROM jobs WHERE id='job'").run();
    expect(sqlite.query("SELECT id FROM webhooks").get()).toEqual({ id: "hook" });
    expect(sqlite.query("SELECT id FROM webhook_deliveries").get()).toEqual({ id: "delivery" });
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    sqlite.close();
  }
});
