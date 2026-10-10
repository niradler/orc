import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { drainRuleActions, reconcileRuleActions } from "../rule-actions.js";

const root = mkdtempSync(join(tmpdir(), "orc-rules-runner-"));
const originalEnabled = process.env.ORC_RULES_ENABLED;
const originalDb = process.env.ORC_DB_PATH;
beforeAll(() => {
  process.env.ORC_RULES_ENABLED = "true";
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
});
afterAll(() => {
  closeDb();
  if (originalEnabled === undefined) delete process.env.ORC_RULES_ENABLED;
  else process.env.ORC_RULES_ENABLED = originalEnabled;
  if (originalDb === undefined) delete process.env.ORC_DB_PATH;
  else process.env.ORC_DB_PATH = originalDb;
  resetConfig();
  rmSync(root, { recursive: true, force: true });
});

test("actual job dispatch runs once, cancelled policies do not run, crashes retain uncertainty", async () => {
  const db = getSqlite();
  const store = new RuleStore(db);
  db.query(
    "INSERT INTO jobs(id,name,command,trigger_type,working_dir,enabled,created_at,updated_at) VALUES ('job','guard-job',?,'manual',?,1,unixepoch(),unixepoch())",
  ).run("printf x >> marker.txt", root);
  const policy = {
    workspace: root,
    project_id: null,
    rules: [
      {
        id: "job",
        kind: "enqueue_job",
        event: "post_tool",
        tools: ["Write"],
        job_id: "job",
        reason: "Validate",
      },
    ],
  };
  const first = store.activate(policy, null, "Start");
  const event = {
    id: "one",
    session_id: "s",
    backend: "test",
    cwd: root,
    phase: "post_tool",
    tool: "Write",
    input: {},
  };
  store.evaluate(event);
  store.evaluate(event);
  await Promise.all([drainRuleActions(), drainRuleActions()]);
  await drainRuleActions();
  expect(readFileSync(join(root, "marker.txt"), "utf8")).toBe("x");
  expect(store.actions()[0]?.status).toBe("done");
  store.evaluate({ ...event, id: "cancelled" });
  const disabled = store.revert(first.id, "Disable before dispatch");
  await drainRuleActions();
  expect(store.actions()[0]?.status).toBe("cancelled");
  expect(readFileSync(join(root, "marker.txt"), "utf8")).toBe("x");
  store.activate(policy, disabled.id, "Restore");
  store.evaluate({ ...event, id: "restart" });
  db.query("UPDATE rule_actions SET status='running' WHERE status='pending'").run();
  reconcileRuleActions();
  expect(store.actions().find((a) => a.error?.includes("external effects unknown"))?.status).toBe(
    "failed",
  );
  await drainRuleActions();
  expect(readFileSync(join(root, "marker.txt"), "utf8")).toBe("x");
});

test("mutated job ownership and disabled jobs are rejected at dispatch; recursive events cannot enqueue", async () => {
  const db = getSqlite();
  const store = new RuleStore(db);
  const event = {
    id: "ownership",
    session_id: "s",
    backend: "test",
    cwd: root,
    phase: "post_tool",
    tool: "Write",
    input: {},
  };
  store.evaluate(event);
  db.query(
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES('other','other',unixepoch(),unixepoch())",
  ).run();
  db.query("UPDATE jobs SET project_id='other' WHERE id='job'").run();
  await drainRuleActions();
  expect(store.actions()[0]?.status).toBe("cancelled");
  db.query("UPDATE jobs SET project_id=NULL WHERE id='job'").run();
  store.evaluate({ ...event, id: "disabled" });
  db.query("UPDATE jobs SET enabled=0 WHERE id='job'").run();
  await drainRuleActions();
  expect(store.actions().find((a) => a.error === "Job disabled or unavailable")?.status).toBe(
    "failed",
  );
  const count = db.query<{ n: number }, []>("SELECT count(*) n FROM rule_actions").get()?.n;
  const original = process.env.ORC_RULE_ACTION;
  try {
    process.env.ORC_RULE_ACTION = "1";
    store.evaluate({ ...event, id: "recursive" });
  } finally {
    if (original === undefined) delete process.env.ORC_RULE_ACTION;
    else process.env.ORC_RULE_ACTION = original;
  }
  expect(db.query<{ n: number }, []>("SELECT count(*) n FROM rule_actions").get()?.n).toBe(count);
});
