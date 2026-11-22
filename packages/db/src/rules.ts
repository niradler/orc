import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { ConflictError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { processRuleCommand } from "@orc/core/rule-command";
import { ruleEventCapability } from "@orc/core/rule-events";
import { matchesRuleFilter } from "@orc/core/rule-filters";
import { runRuleScript } from "@orc/core/rule-script";
import type { RuleRevision } from "@orc/core/rule-types";
import {
  canonicalWorkspace,
  evaluateRules,
  isRuleOutcome,
  RULE_DAY_MS,
  type RuleDecision,
  type RuleEvent,
  RuleEventSchema,
  type RulePolicy,
  RulePolicySchema,
  ruleDecisionDay,
  ruleDecisionHits,
  withinWorkspace,
} from "@orc/core/rules";

export type { RuleRevision } from "@orc/core/rule-types";

function workspaceFilter(workspace: string | undefined): [string | null, string | null] {
  const key =
    workspace && existsSync(workspace) ? realpathSync(resolve(workspace)) : (workspace ?? null);
  return [key, key];
}

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
    CREATE TABLE IF NOT EXISTS rule_counters (
      workspace TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES rule_revisions(id),
      phase TEXT NOT NULL,tool TEXT NOT NULL DEFAULT '',day INTEGER NOT NULL,
      events INTEGER NOT NULL DEFAULT 0,abstains INTEGER NOT NULL DEFAULT 0,
      first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,
      PRIMARY KEY(workspace,revision_id,phase,tool,day)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS rule_counters_day_idx ON rule_counters(day);
    CREATE TABLE IF NOT EXISTS rule_hits (
      workspace TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES rule_revisions(id),
      rule_id TEXT NOT NULL,outcome TEXT NOT NULL,day INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,last_seen INTEGER NOT NULL,
      PRIMARY KEY(workspace,revision_id,rule_id,outcome,day)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS rule_hits_day_idx ON rule_hits(day);
    CREATE TABLE IF NOT EXISTS rule_migrations (name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL);
  `);
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(rule_actions)").all();
  if (!columns.some((column) => column.name === "event_json"))
    db.exec("ALTER TABLE rule_actions ADD COLUMN event_json TEXT");
  migrateRuleStorage(db);
}

/**
 * One-time fold of the pre-counter decision log into counters. Existing
 * abstains become counter rows and are deleted; outcome rows stay and are
 * counted once. A marker makes every later open a no-op, and the fold shares
 * one transaction so a crash rolls both the counts and the deletes back.
 */
function migrateRuleStorage(db: Database): number {
  const done = db.query("SELECT 1 FROM rule_migrations WHERE name='rule_counters_v1'").get();
  if (done) return 0;
  const rows = db
    .query<
      {
        id: string;
        revision_id: string;
        workspace: string;
        phase: string;
        tool: string | null;
        result: string;
        created_at: number;
      },
      []
    >(
      `SELECT d.id,d.revision_id,r.workspace,d.phase,d.tool,d.result,d.created_at
       FROM rule_decisions d JOIN rule_revisions r ON r.id=d.revision_id`,
    )
    .all();
  const moved: string[] = [];
  db.transaction(() => {
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.result);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const result = parsed as RuleDecision;
      if (result.decision !== "abstain" && result.decision !== "deny") {
        countEvent(db, {
          workspace: row.workspace,
          revision_id: row.revision_id,
          phase: row.phase,
          tool: row.tool,
          at: row.created_at,
          abstain: false,
        });
        continue;
      }
      const counter: RuleCounterInput = {
        workspace: row.workspace,
        revision_id: row.revision_id,
        phase: row.phase,
        tool: row.tool,
        at: row.created_at,
        abstain: !isRuleOutcome(result),
      };
      countEvent(db, counter);
      if (counter.abstain) moved.push(row.id);
      else countHits(db, counter, result);
    }
    for (let start = 0; start < moved.length; start += 500) {
      const chunk = moved.slice(start, start + 500);
      db.query(`DELETE FROM rule_decisions WHERE id IN (${chunk.map(() => "?").join(",")})`).run(
        ...chunk,
      );
    }
    db.query("INSERT INTO rule_migrations(name,applied_at) VALUES ('rule_counters_v1',?)").run(
      Date.now(),
    );
  }).immediate();
  if (moved.length)
    console.info(`[orc] moved ${moved.length} abstain rule decisions into counters`);
  return moved.length;
}

type RuleCounterInput = {
  workspace: string;
  revision_id: string;
  phase: string;
  tool: string | null;
  at: number;
  abstain: boolean;
};

function countEvent(db: Database, input: RuleCounterInput): void {
  db.query(
    `INSERT INTO rule_counters(workspace,revision_id,phase,tool,day,events,abstains,first_seen,last_seen)
     VALUES (?,?,?,?,?,1,?,?,?)
     ON CONFLICT(workspace,revision_id,phase,tool,day) DO UPDATE SET
       events=events+1,
       abstains=abstains+excluded.abstains,
       first_seen=min(first_seen,excluded.first_seen),
       last_seen=max(last_seen,excluded.last_seen)`,
  ).run(
    input.workspace,
    input.revision_id,
    input.phase,
    input.tool ?? "",
    ruleDecisionDay(input.at),
    input.abstain ? 1 : 0,
    input.at,
    input.at,
  );
}

function countHits(db: Database, input: RuleCounterInput, result: RuleDecision): void {
  for (const hit of ruleDecisionHits(result)) {
    db.query(
      `INSERT INTO rule_hits(workspace,revision_id,rule_id,outcome,day,count,last_seen)
       VALUES (?,?,?,?,?,1,?)
       ON CONFLICT(workspace,revision_id,rule_id,outcome,day) DO UPDATE SET
         count=count+1,
         last_seen=max(last_seen,excluded.last_seen)`,
    ).run(
      input.workspace,
      input.revision_id,
      hit.rule_id,
      hit.outcome,
      ruleDecisionDay(input.at),
      input.at,
    );
  }
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

/** Row cap for history(); clients treat a full page as possibly truncated. */
export const RULE_HISTORY_LIMIT = 200;

export class RuleStore {
  constructor(readonly db: Database) {
    installRules(db);
  }

  evaluateCommand(raw: unknown): RuleDecision {
    const event = RuleEventSchema.parse(raw);
    const original = this.evaluate(event);
    const result = processRuleCommand(event, original, (replacement) =>
      this.evaluate(replacement, true, true),
    );
    if (!original.command_processors?.length) return result;
    const serialized = JSON.stringify(event);
    const inputHash = createHash("sha256").update(serialized).digest("hex");
    const redacted = {
      decision: result.decision,
      reasons: result.reasons,
      context: [],
      jobs: [],
      command_processing: {
        rule_ids: original.command_processors.map((processor) => processor.rule_id),
        status:
          result.decision === "deny"
            ? "denied"
            : result.updated_input
              ? "rewritten"
              : "passthrough",
        command_hash: result.updated_input
          ? createHash("sha256").update(JSON.stringify(result.updated_input)).digest("hex")
          : null,
      },
    };
    const outcome = result.decision === "deny" || result.updated_input !== undefined;
    const routeDecision: RuleDecision = {
      decision: result.decision,
      reasons: result.reasons,
      context: [],
      jobs: [],
      ...(result.updated_input === undefined
        ? {}
        : { command_processors: original.command_processors }),
    };
    for (const active of this.active(event.cwd)) {
      if (
        !active.policy?.rules.some((rule) =>
          original.command_processors?.some((processor) => processor.rule_id === rule.id),
        )
      )
        continue;
      const now = Date.now();
      const counter: RuleCounterInput = {
        workspace: active.workspace,
        revision_id: active.id,
        phase: "command_route",
        tool: event.tool ?? null,
        at: now,
        abstain: false,
      };
      countEvent(this.db, counter);
      if (!outcome) continue;
      const eventKey = createHash("sha256")
        .update(
          JSON.stringify([active.id, event.backend, event.session_id, event.id, "command_route"]),
        )
        .digest("hex");
      this.db
        .query(
          "INSERT INTO rule_decisions(id,event_key,input_hash,revision_id,session_id,phase,tool,result,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET result=excluded.result",
        )
        .run(
          ulid(),
          eventKey,
          inputHash,
          active.id,
          event.session_id,
          "command_route",
          event.tool ?? null,
          JSON.stringify(redacted),
          now,
        );
      countHits(this.db, counter, routeDecision);
    }
    return result;
  }

  history(workspace?: string): RuleRevision[] {
    return this.db
      .query<RevisionRow, [string | null, string | null]>(
        `SELECT r.*,h.revision_id=r.id AS current FROM rule_revisions r LEFT JOIN rule_heads h ON h.workspace=r.workspace WHERE (? IS NULL OR r.workspace=?) ORDER BY r.created_at DESC,r.id DESC LIMIT ${RULE_HISTORY_LIMIT}`,
      )
      .all(...workspaceFilter(workspace))
      .map(revision);
  }

  active(cwd?: string): RuleRevision[] {
    const rows = this.db
      .query<RevisionRow, []>(
        `SELECT r.*,1 AS current FROM rule_heads h JOIN rule_revisions r ON r.id=h.revision_id WHERE r.payload IS NOT NULL`,
      )
      .all();
    const path = cwd === undefined ? null : workspace(cwd);
    const scoped = rows
      .map(revision)
      .filter((r) => path === null || withinWorkspace(r.workspace, path));
    if (scoped.length > 1000) throw new ValidationError("Too many active workspace policies");
    return scoped;
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
          const jobId = rule.target.type === "job" ? rule.target.job_id : null;
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

  evaluate(raw: unknown, record = true, validation = false): RuleDecision {
    const event = RuleEventSchema.parse(raw);
    const serialized = JSON.stringify(event);
    if (serialized.length > 1_100_000) throw new ValidationError("Rule event exceeds input limit");
    const combined: RuleDecision = {
      decision: "abstain",
      reasons: [],
      context: [],
      jobs: [],
    };
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
    if (!validation && process.env.ORC_RULE_ACTION !== "1") {
      const applicable = policies
        .flatMap((active) => active.policy?.rules ?? [])
        .filter(
          (rule) =>
            rule.kind === "event" &&
            rule.enabled &&
            (rule.scope.agents === "all" ||
              rule.scope.agents.some((agent) => agent === event.backend)) &&
            rule.scope.events.some(
              (name) => name === event.phase || name === `native:${event.native_event}`,
            ),
        );
      const processors = applicable.filter(
        (rule) =>
          rule.kind === "event" &&
          rule.target.type === "rewrite_command" &&
          matchesRuleFilter(rule.filter, event),
      );
      if (processors.length) {
        const validationBudget = applicable.reduce(
          (sum, rule) =>
            sum +
            (rule.kind === "event" && rule.target.type === "script" && rule.target.mode === "sync"
              ? rule.target.timeout_ms
              : 0),
          0,
        );
        const processorBudget = processors.reduce(
          (sum, rule) =>
            sum +
            (rule.kind === "event" && rule.target.type === "rewrite_command"
              ? rule.target.timeout_ms
              : 0),
          0,
        );
        if (synchronousBudget + validationBudget + processorBudget > 5000)
          throw new ValidationError(
            "Combined command processing and validation timeout exceeds 5000ms",
          );
      }
    }
    for (const active of policies) {
      if (!active.policy) continue;
      const result = record
        ? this.record(active, event, serialized, validation)
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
      if (result.command_processors?.length && !validation) {
        combined.command_processors ??= [];
        combined.command_processors.push(...result.command_processors);
      }
      if (result.orc_actions?.length && !validation) {
        combined.orc_actions ??= [];
        combined.orc_actions.push(
          ...result.orc_actions.map((action) => ({ ...action, revision_id: active.id })),
        );
      }
      if (result.human_requests?.length && !validation) {
        combined.human_requests ??= [];
        combined.human_requests.push(
          ...result.human_requests.map((action) => ({ ...action, revision_id: active.id })),
        );
      }
    }
    if (combined.context.reduce((sum, text) => sum + text.length, 0) > 32000)
      throw new ValidationError("Combined rule context exceeds 32000 characters");
    return combined;
  }

  private record(
    active: RuleRevision,
    event: RuleEvent,
    serialized: string,
    validation: boolean,
  ): RuleDecision {
    if (!active.policy) throw new ValidationError("Inactive policy");
    const inputHash = createHash("sha256").update(serialized).digest("hex");
    const eventKey = createHash("sha256")
      .update(
        JSON.stringify([
          active.id,
          event.backend,
          event.session_id,
          event.id,
          event.phase,
          ...(validation ? ["command-validation"] : []),
        ]),
      )
      .digest("hex");
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
    if (process.env.ORC_RULE_ACTION === "1") {
      result.jobs = [];
      result.scripts = [];
      result.command_processors = [];
      result.orc_actions = [];
      result.human_requests = [];
    }
    if (validation) {
      result.jobs = [];
      result.command_processors = [];
      result.orc_actions = [];
      result.human_requests = [];
      result.scripts = (result.scripts ?? []).filter((script) => script.target.mode === "sync");
    }
    const now = Date.now();
    const counter: RuleCounterInput = {
      workspace: active.workspace,
      revision_id: active.id,
      phase: event.phase,
      tool: event.tool ?? null,
      at: now,
      abstain: false,
    };
    if (!isRuleOutcome(result)) {
      countEvent(this.db, { ...counter, abstain: true });
      return result;
    }
    const synchronous = result.scripts?.some((script) => script.target.mode === "sync");
    const recorded = this.db
      .transaction(() => {
        const raced = this.db
          .query<{ input_hash: string; result: string }, [string]>(
            "SELECT input_hash,result FROM rule_decisions WHERE event_key=?",
          )
          .get(eventKey);
        if (raced) {
          if (raced.input_hash !== inputHash)
            throw new ConflictError("Event identity reused with different input");
          return {
            fresh: false,
            finalized: true,
            id: "",
            result: JSON.parse(raced.result) as RuleDecision,
          };
        }
        const id = ulid();
        countEvent(this.db, counter);
        if (!synchronous) countHits(this.db, counter, result);
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
    const finalResult = recorded.result;
    for (const script of finalResult.scripts ?? []) {
      if (script.target.mode !== "sync") continue;
      try {
        const output = runRuleScript(script.target, event);
        const capability = ruleEventCapability(event.backend, event.phase);
        if (output.decision === "deny" && !capability?.block)
          throw new Error("Script returned deny for a non-blocking event");
        if (output.context.length && !capability?.context)
          throw new Error("Script returned context for an event that cannot inject it");
        if (output.decision === "deny") {
          finalResult.decision = "deny";
          finalResult.reasons.push({
            rule_id: script.rule_id,
            reason: output.reason ?? "Script denied event",
          });
        }
        finalResult.context.push(...output.context);
      } catch {
        finalResult.decision = "deny";
        finalResult.reasons.push({
          rule_id: script.rule_id,
          reason: "Custom script failed or returned an unsupported result",
        });
      }
    }
    if (finalResult.context.join("").length > 32000) {
      finalResult.context = [];
      finalResult.decision = "deny";
      finalResult.reasons.push({
        rule_id: "context-limit",
        reason: "Combined script context exceeds limit",
      });
    }
    this.db
      .transaction(() => {
        this.db
          .query("UPDATE rule_decisions SET result=? WHERE id=?")
          .run(JSON.stringify(finalResult), recorded.id);
        countHits(this.db, counter, finalResult);
        this.enqueue(active, event, serialized, finalResult, recorded.id);
      })
      .immediate();
    return finalResult;
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
      .all(...workspaceFilter(workspace));
  }

  actions(workspace?: string) {
    return this.db
      .query<
        {
          id: string;
          job_id: string;
          status: string;
          run_id: string | null;
          error: string | null;
        },
        [string | null, string | null]
      >(
        "SELECT a.id,a.job_id,a.status,a.run_id,a.error FROM rule_actions a JOIN rule_decisions d ON d.id=a.decision_id JOIN rule_revisions r ON r.id=d.revision_id WHERE (? IS NULL OR r.workspace=?) ORDER BY a.created_at DESC,a.id DESC LIMIT 200",
      )
      .all(...workspaceFilter(workspace));
  }

  metrics(workspace?: string, days = 30, nowMs = Date.now()): RuleMetrics {
    const windowDays = Math.min(3650, Math.max(1, Math.floor(days)));
    const cutoffDay = ruleDecisionDay(nowMs - windowDays * RULE_DAY_MS);
    const filter = workspaceFilter(workspace);
    const totals = this.db
      .query<{ events: number; abstains: number }, [number, string | null, string | null]>(
        `SELECT COALESCE(SUM(events),0) AS events,COALESCE(SUM(abstains),0) AS abstains
         FROM rule_counters WHERE day>=? AND (? IS NULL OR workspace=?)`,
      )
      .get(cutoffDay, ...filter) ?? { events: 0, abstains: 0 };
    const perRule = this.db
      .query<
        {
          workspace: string;
          revision_id: string;
          rule_id: string;
          outcome: string;
          count: number;
          last_seen: number;
        },
        [number, string | null, string | null]
      >(
        `SELECT workspace,revision_id,rule_id,outcome,SUM(count) AS count,MAX(last_seen) AS last_seen
         FROM rule_hits WHERE day>=? AND (? IS NULL OR workspace=?)
         GROUP BY workspace,revision_id,rule_id,outcome ORDER BY count DESC LIMIT 200`,
      )
      .all(cutoffDay, ...filter);
    const denials =
      this.db
        .query<{ count: number }, [number, string | null, string | null]>(
          `SELECT COALESCE(SUM(count),0) AS count FROM rule_hits
           WHERE outcome='deny' AND day>=? AND (? IS NULL OR workspace=?)`,
        )
        .get(cutoffDay, ...filter)?.count ?? 0;
    return {
      days: windowDays,
      totals: {
        events: totals.events,
        abstains: totals.abstains,
        outcomes: totals.events - totals.abstains,
        denials,
        abstain_rate: totals.events ? totals.abstains / totals.events : 0,
      },
      per_workspace: this.db
        .query<
          {
            workspace: string;
            events: number;
            abstains: number;
            outcomes: number;
            last_seen: number;
          },
          [number, string | null, string | null]
        >(
          `SELECT workspace,SUM(events) AS events,SUM(abstains) AS abstains,
                  SUM(events-abstains) AS outcomes,MAX(last_seen) AS last_seen
           FROM rule_counters WHERE day>=? AND (? IS NULL OR workspace=?)
           GROUP BY workspace ORDER BY events DESC`,
        )
        .all(cutoffDay, ...filter),
      per_rule: perRule,
      per_day: this.db
        .query<
          { day: number; events: number; abstains: number },
          [number, string | null, string | null]
        >(
          `SELECT day,SUM(events) AS events,SUM(abstains) AS abstains
           FROM rule_counters WHERE day>=? AND (? IS NULL OR workspace=?)
           GROUP BY day ORDER BY day`,
        )
        .all(cutoffDay, ...filter),
    };
  }
}

export type RuleMetrics = {
  days: number;
  totals: {
    events: number;
    abstains: number;
    outcomes: number;
    denials: number;
    abstain_rate: number;
  };
  per_workspace: {
    workspace: string;
    events: number;
    abstains: number;
    outcomes: number;
    last_seen: number;
  }[];
  per_rule: {
    workspace: string;
    revision_id: string;
    rule_id: string;
    outcome: string;
    count: number;
    last_seen: number;
  }[];
  per_day: { day: number; events: number; abstains: number }[];
};

export const DEFAULT_RULE_RETENTION_DAYS = 30;
export const MAX_RULE_DECISION_ROWS = 200_000;
export const MAX_RULE_AGGREGATE_ROWS = 20_000;
const DEFAULT_RULE_PRUNE_BATCH = 1000;

export type RulePruneOptions = {
  retentionDays?: number | undefined;
  maxRows?: number | undefined;
  nowMs?: number | undefined;
  batchSize?: number | undefined;
};

/**
 * Bounded retention for decisions and their aggregates. Pending actions keep
 * their decision; finished actions are removed with it. Never runs on the hook
 * path and never runs VACUUM, so it cannot block a tool call.
 */
export function pruneRuleStorage(db: Database, options: RulePruneOptions = {}): number {
  const retentionDays = options.retentionDays ?? DEFAULT_RULE_RETENTION_DAYS;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650)
    throw new RangeError("Rule retention must be an integer from 1 to 3650 days");
  const maxRows = options.maxRows ?? MAX_RULE_DECISION_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1000)
    throw new RangeError("Rule decision cap must be an integer of at least 1000 rows");
  const batchSize = options.batchSize ?? DEFAULT_RULE_PRUNE_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000)
    throw new RangeError("Rule prune batch must be an integer from 1 to 10000 rows");
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = nowMs - retentionDays * RULE_DAY_MS;
  const cutoffDay = ruleDecisionDay(cutoff);
  return db
    .transaction(() => {
      const deleteIds = (ids: string[]): number => {
        for (let start = 0; start < ids.length; start += 500) {
          const chunk = ids.slice(start, start + 500);
          const marks = chunk.map(() => "?").join(",");
          db.query(`DELETE FROM rule_actions WHERE decision_id IN (${marks})`).run(...chunk);
          db.query(`DELETE FROM rule_decisions WHERE id IN (${marks})`).run(...chunk);
        }
        return ids.length;
      };
      const expired = deleteIds(
        db
          .query<{ id: string }, [number, number]>(
            `SELECT d.id FROM rule_decisions d
             WHERE d.created_at<? AND NOT EXISTS (
               SELECT 1 FROM rule_actions a WHERE a.decision_id=d.id AND a.status='pending'
             )
             ORDER BY d.created_at,d.rowid LIMIT ?`,
          )
          .all(cutoff, batchSize)
          .map((row) => row.id),
      );
      const overflow = deleteIds(
        db
          .query<{ id: string }, [number, number]>(
            `SELECT d.id FROM rule_decisions d
             WHERE NOT EXISTS (
               SELECT 1 FROM rule_actions a WHERE a.decision_id=d.id AND a.status='pending'
             )
             ORDER BY d.created_at DESC,d.rowid DESC LIMIT ? OFFSET ?`,
          )
          .all(batchSize, maxRows)
          .map((row) => row.id),
      );
      for (const table of ["rule_counters", "rule_hits"] as const) {
        if (table === "rule_counters")
          db.query(
            `DELETE FROM rule_counters WHERE day IN (
               SELECT day FROM rule_counters WHERE day<? GROUP BY day ORDER BY day LIMIT ?
             )`,
          ).run(cutoffDay, batchSize);
        else
          db.query(
            `DELETE FROM rule_hits WHERE day IN (
               SELECT day FROM rule_hits WHERE day<? GROUP BY day ORDER BY day LIMIT ?
             )`,
          ).run(cutoffDay, batchSize);
        const count =
          db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ??
          0;
        if (count <= MAX_RULE_AGGREGATE_ROWS) continue;
        const excess = Math.min(count - MAX_RULE_AGGREGATE_ROWS, batchSize);
        if (table === "rule_counters")
          db.query(
            `DELETE FROM rule_counters WHERE (workspace,revision_id,phase,tool,day) IN (
               SELECT workspace,revision_id,phase,tool,day FROM rule_counters
               ORDER BY day,workspace,revision_id,phase,tool LIMIT ?
             )`,
          ).run(excess);
        else
          db.query(
            `DELETE FROM rule_hits WHERE (workspace,revision_id,rule_id,outcome,day) IN (
               SELECT workspace,revision_id,rule_id,outcome,day FROM rule_hits
               ORDER BY day,workspace,revision_id,rule_id,outcome LIMIT ?
             )`,
          ).run(excess);
      }
      return expired + overflow;
    })
    .immediate();
}
