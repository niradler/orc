import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ConflictError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { ruleEventCapability } from "@orc/core/rule-events";
import { matchesRuleFilter } from "@orc/core/rule-filters";
import { runRuleScript } from "@orc/core/rule-script";
import type { RuleRevision } from "@orc/core/rule-types";
import {
  canonicalWorkspace,
  evaluateRules,
  type RuleDecision,
  type RuleEvent,
  RuleEventSchema,
  type RulePolicy,
  RulePolicySchema,
  withinWorkspace,
} from "@orc/core/rules";

export type { RuleRevision } from "@orc/core/rule-types";

function workspace(path: string): string {
  try {
    return canonicalWorkspace(path);
  } catch {
    throw new ValidationError("Workspace must exist and be accessible");
  }
}

export function installRules(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_revisions (
      id TEXT PRIMARY KEY,workspace TEXT NOT NULL,project_id TEXT,payload TEXT,
      previous_id TEXT,reason TEXT NOT NULL,created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rule_heads (workspace TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES rule_revisions(id));
    CREATE TABLE IF NOT EXISTS rule_decisions (
      id TEXT PRIMARY KEY,event_key TEXT UNIQUE NOT NULL,input_hash TEXT NOT NULL,
      revision_id TEXT NOT NULL REFERENCES rule_revisions(id),session_id TEXT NOT NULL,
      phase TEXT NOT NULL,tool TEXT,result TEXT NOT NULL,created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rule_decisions_revision_idx ON rule_decisions(revision_id,created_at);
    CREATE TABLE IF NOT EXISTS rule_actions (
      id TEXT PRIMARY KEY,decision_id TEXT NOT NULL REFERENCES rule_decisions(id),rule_id TEXT NOT NULL,
      job_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',run_id TEXT,error TEXT,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      UNIQUE(decision_id,rule_id)
    );
  `);
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(rule_actions)").all();
  if (!columns.some((column) => column.name === "event_json"))
    db.exec("ALTER TABLE rule_actions ADD COLUMN event_json TEXT");
}

type RevisionRow = Omit<RuleRevision, "policy" | "current"> & {
  payload: string | null;
  current: number;
};
function revision(row: RevisionRow): RuleRevision {
  const { payload, current, ...rest } = row;
  return {
    ...rest,
    policy: payload === null ? null : RulePolicySchema.parse(JSON.parse(payload)),
    current: Boolean(current),
  };
}

export class RuleStore {
  constructor(readonly db: Database) {
    installRules(db);
  }

  history(workspace?: string): RuleRevision[] {
    return this.db
      .query<RevisionRow, [string | null, string | null]>(
        `SELECT r.*,h.revision_id=r.id AS current FROM rule_revisions r LEFT JOIN rule_heads h ON h.workspace=r.workspace WHERE (? IS NULL OR r.workspace=?) ORDER BY r.created_at DESC,r.id DESC LIMIT 200`,
      )
      .all(workspace ?? null, workspace ?? null)
      .map(revision);
  }

  active(cwd?: string): RuleRevision[] {
    const rows = this.db
      .query<RevisionRow, []>(
        `SELECT r.*,1 AS current FROM rule_heads h JOIN rule_revisions r ON r.id=h.revision_id WHERE r.payload IS NOT NULL`,
      )
      .all();
    if (rows.length > 1000) throw new ValidationError("Too many active workspace policies");
    const path = cwd === undefined ? null : workspace(cwd);
    return rows.map(revision).filter((r) => path === null || withinWorkspace(r.workspace, path));
  }

  activate(raw: unknown, expected: string | null, reason: string): RuleRevision {
    const policy = RulePolicySchema.parse(raw);
    policy.workspace = workspace(policy.workspace);
    return this.write(policy.workspace, policy.project_id, policy, expected, reason);
  }

  private write(
    workspace: string,
    project: string | null,
    policy: RulePolicy | null,
    expected: string | null,
    reason: string,
  ): RuleRevision {
    if (!reason.trim() || reason.length > 4000)
      throw new ValidationError("A bounded reason is required");
    return this.db
      .transaction(() => {
        const current =
          this.db
            .query<{ revision_id: string }, [string]>(
              "SELECT revision_id FROM rule_heads WHERE workspace=?",
            )
            .get(workspace)?.revision_id ?? null;
        if (current !== expected)
          throw new ConflictError("Rule policy changed; reload its history before updating");
        if (project !== null && !this.db.query("SELECT id FROM projects WHERE id=?").get(project))
          throw new ValidationError("Unknown policy project");
        for (const rule of policy?.rules ?? []) {
          const jobId =
            rule.kind === "enqueue_job"
              ? rule.job_id
              : rule.kind === "event" && rule.target.type === "job"
                ? rule.target.job_id
                : null;
          if (!jobId) continue;
          const job = this.db
            .query<{ project_id: string | null; command: string }, [string]>(
              "SELECT project_id,command FROM jobs WHERE id=? AND enabled=1",
            )
            .get(jobId);
          if (!job || job.project_id !== project || job.command.startsWith("__internal:"))
            throw new ValidationError(
              "Rule action requires an enabled ordinary job in the same project",
            );
        }
        const id = ulid();
        const created_at = Date.now();
        this.db
          .query(
            "INSERT INTO rule_revisions(id,workspace,project_id,payload,previous_id,reason,created_at) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            id,
            workspace,
            project,
            policy ? JSON.stringify(policy) : null,
            current,
            reason.trim(),
            created_at,
          );
        this.db
          .query(
            "INSERT INTO rule_heads(workspace,revision_id) VALUES (?,?) ON CONFLICT(workspace) DO UPDATE SET revision_id=excluded.revision_id",
          )
          .run(workspace, id);
        return {
          id,
          workspace,
          project_id: project,
          policy,
          previous_id: current,
          reason: reason.trim(),
          created_at,
          current: true,
        };
      })
      .immediate();
  }

  revert(id: string, reason: string): RuleRevision {
    const row = this.db
      .query<RevisionRow, [string]>("SELECT r.*,1 AS current FROM rule_revisions r WHERE id=?")
      .get(id);
    if (!row) throw new ValidationError("Unknown rule revision");
    const previous =
      row.previous_id === null
        ? null
        : this.db
            .query<RevisionRow, [string]>(
              "SELECT r.*,0 AS current FROM rule_revisions r WHERE id=?",
            )
            .get(row.previous_id);
    return this.write(
      row.workspace,
      previous ? previous.project_id : row.project_id,
      previous ? revision(previous).policy : null,
      id,
      reason,
    );
  }

  evaluate(raw: unknown, record = true): RuleDecision {
    const event = RuleEventSchema.parse(raw);
    const serialized = JSON.stringify(event);
    if (serialized.length > 1_100_000) throw new ValidationError("Rule event exceeds input limit");
    const combined: RuleDecision = { decision: "abstain", reasons: [], context: [], jobs: [] };
    const policies = this.active(event.cwd);
    const synchronousBudget = policies.reduce(
      (total, active) =>
        total +
        (active.policy?.rules.reduce(
          (sum, rule) =>
            sum +
            (rule.kind === "event" &&
            rule.enabled &&
            rule.target.type === "script" &&
            rule.target.mode === "sync" &&
            (rule.scope.agents === "all" ||
              rule.scope.agents.some((agent) => agent === event.backend)) &&
            rule.scope.events.some(
              (name) => name === event.phase || name === `native:${event.native_event}`,
            ) &&
            matchesRuleFilter(rule.filter, event)
              ? rule.target.timeout_ms
              : 0),
          0,
        ) ?? 0),
      0,
    );
    if (process.env.ORC_RULE_ACTION !== "1" && synchronousBudget > 5000)
      throw new ValidationError("Combined synchronous script timeout exceeds 5000ms");
    for (const active of policies) {
      if (!active.policy) continue;
      const result = record
        ? this.record(active, event, serialized)
        : evaluateRules(active.policy, event, [
            this.db.filename,
            `${this.db.filename}-wal`,
            `${this.db.filename}-shm`,
          ]);
      if (result.decision === "deny") combined.decision = "deny";
      combined.reasons.push(...result.reasons);
      combined.context.push(...result.context);
      combined.jobs.push(...result.jobs);
      if (result.scripts?.length) {
        combined.scripts ??= [];
        combined.scripts.push(...result.scripts);
      }
    }
    if (combined.context.reduce((sum, text) => sum + text.length, 0) > 32000)
      throw new ValidationError("Combined rule context exceeds 32000 characters");
    return combined;
  }

  private record(active: RuleRevision, event: RuleEvent, serialized: string): RuleDecision {
    if (!active.policy) throw new ValidationError("Inactive policy");
    const inputHash = createHash("sha256").update(serialized).digest("hex");
    const eventKey = createHash("sha256")
      .update(JSON.stringify([active.id, event.backend, event.session_id, event.id, event.phase]))
      .digest("hex");
    const recorded = this.db
      .transaction(() => {
        const existing = this.db
          .query<{ input_hash: string; result: string }, [string]>(
            "SELECT input_hash,result FROM rule_decisions WHERE event_key=?",
          )
          .get(eventKey);
        if (existing) {
          if (existing.input_hash !== inputHash)
            throw new ConflictError("Event identity reused with different input");
          return {
            fresh: false,
            finalized: true,
            id: "",
            result: JSON.parse(existing.result) as RuleDecision,
          };
        }
        const result = evaluateRules(active.policy as RulePolicy, event, [
          this.db.filename,
          `${this.db.filename}-wal`,
          `${this.db.filename}-shm`,
        ]);
        if (process.env.ORC_RULE_ACTION === "1") {
          result.jobs = [];
          result.scripts = [];
        }
        const id = ulid();
        const now = Date.now();
        const synchronous = result.scripts?.some((script) => script.target.mode === "sync");
        this.db
          .query(
            "INSERT INTO rule_decisions(id,event_key,input_hash,revision_id,session_id,phase,tool,result,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            eventKey,
            inputHash,
            active.id,
            event.session_id,
            event.phase,
            event.tool ?? null,
            JSON.stringify(
              synchronous
                ? {
                    ...result,
                    decision: "deny",
                    reasons: [
                      ...result.reasons,
                      {
                        rule_id: "script-pending",
                        reason: "Script execution incomplete; external effects unknown",
                      },
                    ],
                  }
                : result,
            ),
            now,
          );
        if (!synchronous) this.enqueue(active, event, serialized, result, id);
        return { fresh: true, finalized: !synchronous, id, result };
      })
      .immediate();
    if (!recorded.fresh || recorded.finalized) return recorded.result;
    const result = recorded.result;
    for (const script of result.scripts ?? []) {
      if (script.target.mode !== "sync") continue;
      try {
        const output = runRuleScript(script.target, event);
        const capability = ruleEventCapability(event.backend, event.phase);
        if (output.decision === "deny" && !capability?.block)
          throw new Error("Script returned deny for a non-blocking event");
        if (output.context.length && !capability?.context)
          throw new Error("Script returned context for an event that cannot inject it");
        if (output.decision === "deny") {
          result.decision = "deny";
          result.reasons.push({
            rule_id: script.rule_id,
            reason: output.reason ?? "Script denied event",
          });
        }
        result.context.push(...output.context);
      } catch {
        result.decision = "deny";
        result.reasons.push({
          rule_id: script.rule_id,
          reason: "Custom script failed or returned an unsupported result",
        });
      }
    }
    if (result.context.join("").length > 32000) {
      result.context = [];
      result.decision = "deny";
      result.reasons.push({
        rule_id: "context-limit",
        reason: "Combined script context exceeds limit",
      });
    }
    this.db
      .transaction(() => {
        this.db
          .query("UPDATE rule_decisions SET result=? WHERE id=?")
          .run(JSON.stringify(result), recorded.id);
        this.enqueue(active, event, serialized, result, recorded.id);
      })
      .immediate();
    return result;
  }

  private enqueue(
    active: RuleRevision,
    event: RuleEvent,
    serialized: string,
    result: RuleDecision,
    decisionId: string,
  ): void {
    const now = Date.now();
    const actions = [...result.jobs];
    for (const script of result.scripts ?? []) {
      if (script.target.mode !== "background") continue;
      const jobId = `rule-script:${active.id}:${script.rule_id}`;
      this.db
        .query(
          "INSERT INTO jobs(id,name,command,project_id,trigger_type,working_dir,timeout_secs,enabled,created_at,updated_at) VALUES (?,?,?,?,'manual',?,?,1,unixepoch(),unixepoch()) ON CONFLICT(id) DO NOTHING",
        )
        .run(
          jobId,
          jobId,
          "__internal:rule-script",
          active.project_id,
          event.cwd,
          Math.ceil(script.target.timeout_ms / 1000),
        );
      actions.push({ rule_id: script.rule_id, job_id: jobId });
    }
    for (const action of actions) {
      const count =
        this.db
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM rule_actions WHERE status='pending'",
          )
          .get()?.count ?? 0;
      this.db
        .query(
          "INSERT INTO rule_actions(id,decision_id,rule_id,job_id,status,error,created_at,updated_at,event_json) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          ulid(),
          decisionId,
          action.rule_id,
          action.job_id,
          count >= 1000 ? "failed" : "pending",
          count >= 1000 ? "Rule action queue capacity exceeded" : null,
          now,
          now,
          count < 1000 && action.job_id.startsWith("rule-script:") ? serialized : null,
        );
    }
  }

  decisions(workspace?: string) {
    return this.db
      .query<
        {
          id: string;
          revision_id: string;
          session_id: string;
          phase: string;
          tool: string | null;
          result: string;
          created_at: number;
        },
        [string | null, string | null]
      >(
        "SELECT d.id,d.revision_id,d.session_id,d.phase,d.tool,d.result,d.created_at FROM rule_decisions d JOIN rule_revisions r ON r.id=d.revision_id WHERE (? IS NULL OR r.workspace=?) ORDER BY d.created_at DESC,d.id DESC LIMIT 200",
      )
      .all(workspace ?? null, workspace ?? null);
  }

  actions(workspace?: string) {
    return this.db
      .query<
        { id: string; job_id: string; status: string; run_id: string | null; error: string | null },
        [string | null, string | null]
      >(
        "SELECT a.id,a.job_id,a.status,a.run_id,a.error FROM rule_actions a JOIN rule_decisions d ON d.id=a.decision_id JOIN rule_revisions r ON r.id=d.revision_id WHERE (? IS NULL OR r.workspace=?) ORDER BY a.created_at DESC,a.id DESC LIMIT 200",
      )
      .all(workspace ?? null, workspace ?? null);
  }
}
