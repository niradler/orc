import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ConflictError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
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
          if (rule.kind !== "enqueue_job") continue;
          const job = this.db
            .query<{ project_id: string | null; command: string }, [string]>(
              "SELECT project_id,command FROM jobs WHERE id=? AND enabled=1",
            )
            .get(rule.job_id);
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
    for (const active of this.active(event.cwd)) {
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
    return this.db
      .transaction(() => {
        const existing = this.db
          .query<{ input_hash: string; result: string }, [string]>(
            "SELECT input_hash,result FROM rule_decisions WHERE event_key=?",
          )
          .get(eventKey);
        if (existing) {
          if (existing.input_hash !== inputHash)
            throw new ConflictError("Event identity reused with different input");
          return JSON.parse(existing.result) as RuleDecision;
        }
        const result = evaluateRules(active.policy as RulePolicy, event, [
          this.db.filename,
          `${this.db.filename}-wal`,
          `${this.db.filename}-shm`,
        ]);
        if (process.env.ORC_RULE_ACTION === "1") result.jobs = [];
        const id = ulid();
        const now = Date.now();
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
            JSON.stringify(result),
            now,
          );
        for (const job of result.jobs) {
          const count =
            this.db
              .query<{ count: number }, []>(
                "SELECT count(*) AS count FROM rule_actions WHERE status='pending'",
              )
              .get()?.count ?? 0;
          this.db
            .query(
              "INSERT INTO rule_actions(id,decision_id,rule_id,job_id,status,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            )
            .run(
              ulid(),
              id,
              job.rule_id,
              job.job_id,
              count >= 1000 ? "failed" : "pending",
              count >= 1000 ? "Rule action queue capacity exceeded" : null,
              now,
              now,
            );
        }
        return result;
      })
      .immediate();
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
