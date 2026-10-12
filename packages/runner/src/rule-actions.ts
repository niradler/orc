import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { type RuleEvent, RuleEventSchema, RulePolicySchema } from "@orc/core/rules";
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
          .query<{ id: string; job_id: string; rule_id: string; event_json: string | null }, []>(
            "SELECT id,job_id,rule_id,event_json FROM rule_actions WHERE status='pending' ORDER BY created_at,id LIMIT 1",
          )
          .get();
        if (!row) return null;
        const job = db
          .query<{ enabled: number; command: string; project_id: string | null }, [string]>(
            "SELECT enabled,command,project_id FROM jobs WHERE id=?",
          )
          .get(row.job_id);
        const scriptJob = job?.command === "__internal:rule-script";
        if (!job?.enabled || (job.command.startsWith("__internal:") && !scriptJob)) {
          db.query(
            "UPDATE rule_actions SET status='failed',event_json=NULL,error='Job disabled or unavailable',updated_at=? WHERE id=?",
          ).run(Date.now(), row.id);
          return null;
        }
        const active = db
          .query<{ id: string; project_id: string | null; payload: string }, [string]>(
            "SELECT r.id,r.project_id,r.payload FROM rule_heads h JOIN rule_revisions r ON r.id=h.revision_id JOIN rule_decisions d ON d.revision_id=h.revision_id JOIN rule_actions a ON a.decision_id=d.id WHERE a.id=?",
          )
          .get(row.id);
        if (!active || active.project_id !== job.project_id) {
          db.query(
            "UPDATE rule_actions SET status='cancelled',event_json=NULL,error='Policy changed before dispatch',updated_at=? WHERE id=?",
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
        let execution:
          | { argv: string[]; stdin: string; timeout_ms: number; cwd: string }
          | undefined;
        if (scriptJob) {
          const rule = RulePolicySchema.parse(JSON.parse(active.payload)).rules.find(
            (entry) => entry.id === row.rule_id,
          );
          if (
            !row.event_json ||
            row.job_id !== `rule-script:${active.id}:${row.rule_id}` ||
            rule?.kind !== "event" ||
            rule.target.type !== "script" ||
            rule.target.mode !== "background"
          ) {
            db.query(
              "UPDATE rule_actions SET status='failed',event_json=NULL,error='Script action configuration invalid',updated_at=? WHERE id=?",
            ).run(Date.now(), row.id);
            return null;
          }
          let event: RuleEvent;
          try {
            event = RuleEventSchema.parse(JSON.parse(row.event_json));
          } catch {
            db.query(
              "UPDATE rule_actions SET status='failed',event_json=NULL,error='Script event payload invalid',updated_at=? WHERE id=?",
            ).run(Date.now(), row.id);
            return null;
          }
          execution = {
            argv: rule.target.argv,
            stdin: JSON.stringify(event),
            timeout_ms: rule.target.timeout_ms,
            cwd: event.cwd,
          };
        }
        const runId = ulid();
        db.query(
          "INSERT INTO job_runs(id,job_id,status,trigger_by,created_at) VALUES (?,?,'pending','rule',unixepoch())",
        ).run(runId, row.job_id);
        db.query(
          "UPDATE rule_actions SET status='running',run_id=?,updated_at=? WHERE id=? AND status='pending'",
        ).run(runId, Date.now(), row.id);
        return { ...row, runId, execution };
      })
      .immediate();
    if (!action) return;
    claimed = action;
    await executeJob({
      jobId: action.job_id,
      runId: action.runId,
      triggerBy: "rule",
      envOverrides: { ORC_RULE_ACTION: "1" },
      ...(action.execution ? { execution: action.execution } : {}),
    });
    const run = db
      .query<{ status: string; error_msg: string | null }, [string]>(
        "SELECT status,error_msg FROM job_runs WHERE id=?",
      )
      .get(action.runId);
    db.query(
      "UPDATE rule_actions SET status=?,event_json=NULL,error=?,updated_at=? WHERE id=?",
    ).run(
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
            "UPDATE rule_actions SET status='failed',event_json=NULL,error=?,updated_at=? WHERE id=? AND status='running'",
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
    "UPDATE rule_actions SET status='failed',event_json=NULL,error='Dispatcher restarted; external effects unknown, inspect run before retrying',updated_at=? WHERE status='running'",
  ).run(Date.now());
}
