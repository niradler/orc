import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { executeJob } from "./executor.js";

const logger = createLogger("runner:rules");
let draining = false;

export async function drainRuleActions(): Promise<void> {
  if (draining || !loadConfig().rules.enabled) return;
  draining = true;
  let claimed: { id: string; runId: string } | null = null;
  try {
    const db = getSqlite();
    new RuleStore(db);
    const action = db
      .transaction(() => {
        const row = db
          .query<{ id: string; job_id: string }, []>(
            "SELECT id,job_id FROM rule_actions WHERE status='pending' ORDER BY created_at,id LIMIT 1",
          )
          .get();
        if (!row) return null;
        const job = db
          .query<{ enabled: number; command: string; project_id: string | null }, [string]>(
            "SELECT enabled,command,project_id FROM jobs WHERE id=?",
          )
          .get(row.job_id);
        if (!job?.enabled || job.command.startsWith("__internal:")) {
          db.query(
            "UPDATE rule_actions SET status='failed',error='Job disabled or unavailable',updated_at=? WHERE id=?",
          ).run(Date.now(), row.id);
          return null;
        }
        const active = db
          .query<{ project_id: string | null }, [string]>(
            "SELECT r.project_id FROM rule_heads h JOIN rule_revisions r ON r.id=h.revision_id JOIN rule_decisions d ON d.revision_id=h.revision_id JOIN rule_actions a ON a.decision_id=d.id WHERE a.id=?",
          )
          .get(row.id);
        if (!active || active.project_id !== job.project_id) {
          db.query(
            "UPDATE rule_actions SET status='cancelled',error='Policy changed before dispatch',updated_at=? WHERE id=?",
          ).run(Date.now(), row.id);
          return null;
        }
        const count =
          db
            .query<{ count: number }, []>(
              "SELECT count(*) AS count FROM job_runs WHERE status IN ('pending','running')",
            )
            .get()?.count ?? 0;
        if (count >= loadConfig().runner.max_concurrent_jobs) return null;
        const runId = ulid();
        db.query(
          "INSERT INTO job_runs(id,job_id,status,trigger_by,created_at) VALUES (?,?,'pending','rule',unixepoch())",
        ).run(runId, row.job_id);
        db.query(
          "UPDATE rule_actions SET status='running',run_id=?,updated_at=? WHERE id=? AND status='pending'",
        ).run(runId, Date.now(), row.id);
        return { ...row, runId };
      })
      .immediate();
    if (!action) return;
    claimed = action;
    await executeJob({
      jobId: action.job_id,
      runId: action.runId,
      triggerBy: "rule",
      envOverrides: { ORC_RULE_ACTION: "1" },
    });
    const run = db
      .query<{ status: string; error_msg: string | null }, [string]>(
        "SELECT status,error_msg FROM job_runs WHERE id=?",
      )
      .get(action.runId);
    db.query("UPDATE rule_actions SET status=?,error=?,updated_at=? WHERE id=?").run(
      run?.status === "done" || run?.status === "success" ? "done" : "failed",
      run?.error_msg ?? null,
      Date.now(),
      action.id,
    );
  } catch (error) {
    if (claimed) {
      try {
        getSqlite()
          .query(
            "UPDATE rule_actions SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'",
          )
          .run(
            "Dispatcher failed; external effects unknown, inspect run before retrying",
            Date.now(),
            claimed.id,
          );
      } catch (auditError) {
        logger.error("Cannot retain rule dispatch failure; reconcile on restart", auditError);
      }
    }
    logger.error("Rule action dispatch failed", error);
  } finally {
    draining = false;
  }
}

export function reconcileRuleActions(): void {
  if (!loadConfig().rules.enabled) return;
  const db = getSqlite();
  new RuleStore(db);
  db.query(
    "UPDATE rule_actions SET status='failed',error='Dispatcher restarted; external effects unknown, inspect run before retrying',updated_at=? WHERE status='running'",
  ).run(Date.now());
}
