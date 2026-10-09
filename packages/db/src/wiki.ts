import type { Database } from "bun:sqlite";
import { loadConfig } from "@orc/core/config";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import type { EvidenceSource } from "@orc/core/retrieval";
import { normalizeTags } from "@orc/core/retrieval";
import type {
  WikiContribution,
  WikiContributionAttempt,
  WikiOutcome,
  WikiPage,
} from "@orc/core/wiki";
import { SkillEvaluationSchema, SkillProposalSchema, WikiOutcomeSchema } from "@orc/core/wiki";
import type { z } from "zod";
import { PassageIndex } from "./retrieval.js";
import { activateSkill, installSkillEvolution } from "./skill-evolution.js";

export function installWiki(sqlite: Database): void {
  installSkillEvolution(sqlite);
  new PassageIndex(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS wiki_pages (
      project_key TEXT NOT NULL, project_id TEXT, slug TEXT NOT NULL, revision INTEGER NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY(project_key,slug)
    );
    CREATE TABLE IF NOT EXISTS wiki_revisions (
      project_key TEXT NOT NULL, slug TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
      contribution_id TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch()),
      PRIMARY KEY(project_key,slug,revision)
    );
    CREATE TABLE IF NOT EXISTS wiki_contributions (
      id TEXT PRIMARY KEY, project_id TEXT, source_id TEXT NOT NULL, version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, task_id TEXT,
      summary TEXT, created_at INTEGER NOT NULL DEFAULT(unixepoch()), updated_at INTEGER NOT NULL DEFAULT(unixepoch()),
      UNIQUE(source_id,version)
    );
    CREATE INDEX IF NOT EXISTS wiki_contribution_queue ON wiki_contributions(status,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS wiki_contribution_source_version ON wiki_contributions(source_id,version);
    CREATE TABLE IF NOT EXISTS wiki_contribution_attempts (
      id TEXT PRIMARY KEY, contribution_id TEXT NOT NULL, outcome TEXT NOT NULL,
      summary TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch())
    );
    CREATE TABLE IF NOT EXISTS skill_proposals (
      id TEXT PRIMARY KEY, project_id TEXT, skill_name TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed', decision TEXT, created_at INTEGER NOT NULL DEFAULT(unixepoch())
    );
    CREATE TABLE IF NOT EXISTS skill_evaluations (
      id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT(unixepoch())
    );
    CREATE TABLE IF NOT EXISTS skill_evaluation_jobs (
      proposal_id TEXT PRIMARY KEY, task_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT(unixepoch())
    );
  `);
}

function projectKey(projectId: string | null): string {
  return projectId === null ? "global:" : `project:${projectId}`;
}

export class WikiStore {
  private readonly index: PassageIndex;
  constructor(private readonly sqlite: Database) {
    installWiki(sqlite);
    this.index = new PassageIndex(sqlite);
  }

  enqueue(source: EvidenceSource): string {
    if (source.kind !== "session")
      throw new ValidationError("Contributions require session/work-unit evidence");
    return this.sqlite.transaction(() => {
      const version = this.index.put(source);
      const existing = this.sqlite
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM wiki_contributions WHERE source_id=? AND version=?",
        )
        .get(source.source_id, version);
      if (existing) return existing.id;
      const id = ulid();
      this.sqlite
        .query("INSERT INTO wiki_contributions(id,project_id,source_id,version) VALUES(?,?,?,?)")
        .run(id, source.project_id, source.source_id, version);
      return id;
    })();
  }

  list(projectId: string | null): WikiPage[] {
    return this.sqlite
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM wiki_pages WHERE project_key=? ORDER BY slug",
      )
      .all(projectKey(projectId))
      .map((row) => JSON.parse(row.payload) as WikiPage);
  }

  history(projectId: string | null, slug: string): WikiPage[] {
    return this.sqlite
      .query<{ payload: string }, [string, string]>(
        "SELECT payload FROM wiki_revisions WHERE project_key=? AND slug=? ORDER BY revision DESC",
      )
      .all(projectKey(projectId), slug)
      .map((row) => JSON.parse(row.payload) as WikiPage);
  }

  contributions(projectId: string | null): WikiContribution[] {
    return this.sqlite
      .query<WikiContribution, [string | null]>(
        "SELECT id,project_id,source_id,version,status,attempts,task_id,summary FROM wiki_contributions WHERE project_id IS ? ORDER BY created_at DESC LIMIT 100",
      )
      .all(projectId);
  }

  attempts(projectId: string | null): WikiContributionAttempt[] {
    return this.sqlite
      .query<WikiContributionAttempt, [string | null]>(
        "SELECT a.id,a.contribution_id,a.outcome,a.summary,a.created_at FROM wiki_contribution_attempts a JOIN wiki_contributions c ON c.id=a.contribution_id WHERE c.project_id IS ? ORDER BY a.created_at DESC,a.id DESC LIMIT 300",
      )
      .all(projectId);
  }

  schedule(limit = 1): number {
    if (limit !== 1) throw new ValidationError("Schedule one maintenance task at a time");
    return this.sqlite.transaction(() => {
      const abandoned = this.sqlite
        .query<{ task_id: string }, []>(
          "SELECT c.task_id FROM wiki_contributions c LEFT JOIN tasks t ON t.id=c.task_id WHERE c.status='processing' AND (t.id IS NULL OR t.status IN ('done','cancelled','blocked','paused'))",
        )
        .all();
      for (const row of abandoned)
        this.finishTask(row.task_id, "Maintenance task ended or halted without a wiki outcome");
      const abandonedEvaluations = this.sqlite
        .query<{ task_id: string }, []>(
          "SELECT j.task_id FROM skill_evaluation_jobs j LEFT JOIN tasks t ON t.id=j.task_id WHERE j.status='processing' AND (t.id IS NULL OR t.status IN ('done','cancelled','blocked','paused'))",
        )
        .all();
      for (const row of abandonedEvaluations)
        this.finishTask(row.task_id, "Evaluation task ended or halted without paired outcomes");
      const active = this.sqlite
        .query("SELECT id FROM wiki_contributions WHERE status='processing' LIMIT 1")
        .get();
      if (active) return 0;
      if (
        this.sqlite
          .query("SELECT proposal_id FROM skill_evaluation_jobs WHERE status='processing' LIMIT 1")
          .get()
      )
        return 0;
      const next = this.sqlite
        .query<{ id: string; kind: "contribution" | "evaluation" }, []>(
          "SELECT id,created_at,'contribution' AS kind FROM wiki_contributions WHERE status IN ('pending','failed') AND attempts<3 UNION ALL SELECT p.id,p.created_at,'evaluation' AS kind FROM skill_proposals p JOIN skill_evaluation_jobs j ON j.proposal_id=p.id WHERE p.status='proposed' AND j.status IN ('pending','failed') AND j.attempts<3 ORDER BY created_at,id LIMIT 1",
        )
        .get();
      if (!next) return 0;
      const queued =
        next.kind === "contribution"
          ? this.sqlite
              .query<WikiContribution, [string]>("SELECT * FROM wiki_contributions WHERE id=?")
              .all(next.id)
          : [];
      for (const contribution of queued) {
        const taskId = ulid();
        const passages = this.sqlite
          .query<{ id: string; payload: string }, [string, string]>(
            "SELECT id,payload FROM evidence_passages WHERE kind='session' AND source_id=? AND version=? ORDER BY ordinal",
          )
          .all(contribution.source_id, contribution.version);
        const body =
          `Maintain the project wiki from this immutable session evidence. Contribution: ${contribution.id}. Project ID: ${contribution.project_id ?? "unassigned"}. Read orc-wiki. Use wiki_apply to record applied, no_change, or failed before reporting your flow outcome. Skill changes require held-out evaluation; never bypass the automatic promotion gate.\n\n` +
          passages
            .slice(0, 20)
            .map((p) => `[${p.id}] ${p.payload}`)
            .join("\n\n");
        this.sqlite
          .query(
            "INSERT INTO tasks(id,project_id,title,body,status,priority,author,skill_name,required_review) VALUES(?,?,?,?,'todo','low','orc-wiki','orc-wiki',0)",
          )
          .run(
            taskId,
            contribution.project_id,
            `Consolidate session ${contribution.source_id}`,
            body,
          );
        this.sqlite
          .query(
            "UPDATE wiki_contributions SET status='processing',task_id=?,attempts=attempts+1,updated_at=unixepoch() WHERE id=?",
          )
          .run(taskId, contribution.id);
      }
      if (!queued.length) {
        const proposal = this.sqlite
          .query<
            { id: string; project_id: string | null; skill_name: string; payload: string },
            [string]
          >("SELECT id,project_id,skill_name,payload FROM skill_proposals WHERE id=?")
          .get(next.id);
        if (proposal) {
          const taskId = ulid();
          const body = `Evaluation-only mode for orc-wiki. Proposal ID: ${proposal.id}. Project ID: ${proposal.project_id ?? "unassigned"}. Run baseline and candidate on the same independently selected held-out cases in isolated workspaces. Preserve outcome artifacts and costs in the evaluation notes. Do not invent cases or claim improvement from ordinary tests. If representative cases or an executable evaluator are unavailable, report blocked with a concrete reason. Otherwise call skill_evaluate with observed paired outcomes before reporting submitted. There is no wiki contribution to apply. Automatic gates decide promotion.\n\nProposal snapshot:\n${proposal.payload}`;
          this.sqlite
            .query(
              "INSERT INTO tasks(id,project_id,title,body,status,priority,author,skill_name,required_review) VALUES(?,?,?,?,'todo','low','orc-wiki','orc-wiki',0)",
            )
            .run(taskId, proposal.project_id, `Evaluate skill ${proposal.skill_name}`, body);
          this.sqlite
            .query(
              "UPDATE skill_evaluation_jobs SET status='processing',task_id=?,attempts=attempts+1,updated_at=unixepoch() WHERE proposal_id=?",
            )
            .run(taskId, proposal.id);
          return 1;
        }
      }
      return queued.length;
    })();
  }

  finishTask(taskId: string, error: string | null): void {
    const evaluationJob = this.sqlite
      .query<{ proposal_id: string }, [string]>(
        "SELECT proposal_id FROM skill_evaluation_jobs WHERE task_id=? AND status='processing'",
      )
      .get(taskId);
    if (evaluationJob) {
      this.sqlite.transaction(() => {
        this.sqlite
          .query(
            "INSERT INTO skill_evaluations(id,proposal_id,payload,result) VALUES(?,?,?,'evaluator_failed')",
          )
          .run(
            ulid(),
            evaluationJob.proposal_id,
            JSON.stringify({
              task_id: taskId,
              error: error ?? "Evaluator ended without observed paired outcomes",
            }),
          );
        this.sqlite
          .query(
            "UPDATE skill_evaluation_jobs SET status='failed',updated_at=unixepoch() WHERE proposal_id=?",
          )
          .run(evaluationJob.proposal_id);
      })();
    }
    const row = this.sqlite
      .query<WikiContribution, [string]>(
        "SELECT * FROM wiki_contributions WHERE task_id=? AND status='processing'",
      )
      .get(taskId);
    if (row)
      this.apply({
        contribution_id: row.id,
        project_id: row.project_id,
        outcome: "failed",
        summary: error
          ? `Worker failed: ${error}`
          : "Worker ended without recording a wiki outcome",
      });
  }

  private checkEvidence(ids: string[], projectId: string | null): void {
    for (const id of ids) {
      const row = this.sqlite
        .query(
          "SELECT p.id FROM evidence_passages p JOIN evidence_versions v ON v.kind=p.kind AND v.source_id=p.source_id AND v.version=p.version WHERE p.id=? AND json_extract(v.payload,'$.project_id') IS ?",
        )
        .get(id, projectId);
      if (!row) throw new ValidationError("Evidence passage missing or belongs to another project");
    }
  }

  apply(input: WikiOutcome): void {
    const outcome = WikiOutcomeSchema.parse(input);
    if ((outcome.outcome === "applied") !== outcome.edits.length > 0)
      throw new ValidationError("Applied outcomes require edits; other outcomes cannot edit pages");
    this.sqlite.transaction(() => {
      const contribution = this.sqlite
        .query<WikiContribution, [string, string | null]>(
          "SELECT * FROM wiki_contributions WHERE id=? AND project_id IS ?",
        )
        .get(outcome.contribution_id, outcome.project_id);
      if (!contribution) throw new NotFoundError("Contribution", outcome.contribution_id);
      if (["applied", "no_change"].includes(contribution.status)) {
        if (contribution.status === outcome.outcome && contribution.summary === outcome.summary)
          return;
        throw new ConflictError("Contribution already completed");
      }
      if (contribution.attempts >= 3 && contribution.status === "failed")
        throw new ConflictError("Contribution exhausted its retry budget");
      for (const edit of outcome.edits) {
        this.checkEvidence(edit.evidence, outcome.project_id);
        const current = this.sqlite
          .query<{ revision: number }, [string, string]>(
            "SELECT revision FROM wiki_pages WHERE project_key=? AND slug=?",
          )
          .get(projectKey(outcome.project_id), edit.slug);
        if ((current?.revision ?? 0) !== edit.expected_revision)
          throw new ConflictError("Wiki page changed; reload before applying");
        const page: WikiPage = {
          slug: edit.slug,
          project_id: outcome.project_id,
          revision: edit.expected_revision + 1,
          title: edit.title,
          content: edit.content,
          tags: normalizeTags(edit.tags),
          evidence: edit.evidence,
          summary: edit.summary,
          updated_at: Math.floor(Date.now() / 1000),
        };
        const payload = JSON.stringify(page);
        this.sqlite
          .query(
            "INSERT INTO wiki_pages(project_key,project_id,slug,revision,payload) VALUES(?,?,?,?,?) ON CONFLICT(project_key,slug) DO UPDATE SET revision=excluded.revision,payload=excluded.payload",
          )
          .run(
            projectKey(outcome.project_id),
            outcome.project_id,
            page.slug,
            page.revision,
            payload,
          );
        this.sqlite
          .query(
            "INSERT INTO wiki_revisions(project_key,slug,revision,payload,contribution_id) VALUES(?,?,?,?,?)",
          )
          .run(
            projectKey(outcome.project_id),
            page.slug,
            page.revision,
            payload,
            outcome.contribution_id,
          );
        this.index.put({
          kind: "wiki",
          source_id: `${projectKey(outcome.project_id)}/${page.slug}`,
          project_id: outcome.project_id,
          title: page.title,
          content: page.content,
          location: `orc://wiki/${encodeURIComponent(outcome.project_id ?? "unassigned")}/${page.slug}`,
          tags: page.tags,
          metadata: {
            revision: String(page.revision),
            evidence: JSON.stringify(page.evidence),
            interpretation: "maintained synthesis",
          },
        });
      }
      this.sqlite
        .query(
          "INSERT INTO wiki_contribution_attempts(id,contribution_id,outcome,summary) VALUES(?,?,?,?)",
        )
        .run(ulid(), outcome.contribution_id, outcome.outcome, outcome.summary);
      this.sqlite
        .query(
          "UPDATE wiki_contributions SET status=?,summary=?,attempts=CASE WHEN task_id IS NULL THEN attempts+1 ELSE attempts END,updated_at=unixepoch() WHERE id=?",
        )
        .run(outcome.outcome, outcome.summary, outcome.contribution_id);
    })();
  }

  propose(input: z.input<typeof SkillProposalSchema>): string {
    const proposal = SkillProposalSchema.parse(input);
    this.checkEvidence(proposal.evidence, proposal.project_id);
    const id = ulid();
    this.sqlite.transaction(() => {
      this.sqlite
        .query("INSERT INTO skill_proposals(id,project_id,skill_name,payload) VALUES(?,?,?,?)")
        .run(id, proposal.project_id, proposal.skill_name, JSON.stringify(proposal));
      this.sqlite.query("INSERT INTO skill_evaluation_jobs(proposal_id) VALUES(?)").run(id);
    })();
    return id;
  }

  evaluate(input: z.input<typeof SkillEvaluationSchema>): { id: string; result: string } {
    const evaluation = SkillEvaluationSchema.parse(input);
    const row = this.sqlite
      .query<{ payload: string; status: string }, [string, string | null]>(
        "SELECT payload,status FROM skill_proposals WHERE id=? AND project_id IS ?",
      )
      .get(evaluation.proposal_id, evaluation.project_id);
    if (!row) throw new NotFoundError("Proposal", evaluation.proposal_id);
    const proposal = SkillProposalSchema.parse(JSON.parse(row.payload));
    const caseIds = evaluation.cases.map((entry) => entry.id);
    if (
      new Set(caseIds).size !== caseIds.length ||
      caseIds.some((id) => proposal.training_cases.includes(id))
    )
      throw new ValidationError("Evaluation cases must be unique and held out from training");
    const baseline = evaluation.cases.filter((entry) => entry.baseline).length;
    const candidate = evaluation.cases.filter((entry) => entry.candidate).length;
    const regressions = evaluation.cases.filter(
      (entry) => entry.baseline && !entry.candidate,
    ).length;
    const result =
      evaluation.validation_passed && candidate > baseline && !regressions
        ? "measured_gain"
        : "no_proven_gain";
    const id = ulid();
    this.sqlite
      .query("INSERT INTO skill_evaluations(id,proposal_id,payload,result) VALUES(?,?,?,?)")
      .run(
        id,
        evaluation.proposal_id,
        JSON.stringify({ ...evaluation, baseline, candidate, regressions }),
        result,
      );
    this.sqlite
      .query(
        "UPDATE skill_evaluation_jobs SET status='completed',updated_at=unixepoch() WHERE proposal_id=?",
      )
      .run(evaluation.proposal_id);
    const policy = loadConfig().wiki;
    if (
      row.status === "proposed" &&
      result === "measured_gain" &&
      evaluation.cases.length >= policy.min_evaluation_cases &&
      (candidate - baseline) / evaluation.cases.length >= policy.min_success_gain
    ) {
      try {
        this.sqlite.transaction(() => {
          activateSkill(this.sqlite, {
            project: proposal.project_id,
            name: proposal.skill_name,
            baselineHash: proposal.baseline_hash,
            candidate: proposal.candidate,
            proposalId: evaluation.proposal_id,
            evaluationId: id,
          });
          this.sqlite
            .query(
              "UPDATE skill_proposals SET status='activated',decision='Automatic validated promotion' WHERE id=? AND status='proposed'",
            )
            .run(evaluation.proposal_id);
        })();
      } catch (error) {
        const reason =
          error instanceof ConflictError ||
          error instanceof ValidationError ||
          error instanceof NotFoundError
            ? error.message
            : "Skill activation failed";
        this.sqlite
          .query(
            "UPDATE skill_evaluations SET result='activation_blocked',payload=json_set(payload,'$.activation_error',?) WHERE id=?",
          )
          .run(reason, id);
        return { id, result: "activation_blocked" };
      }
      return { id, result: "activated" };
    }
    return { id, result };
  }

  reject(proposalId: string, projectId: string | null, reason: string): void {
    if (!reason.trim()) throw new ValidationError("Rejection requires a reason");
    const result = this.sqlite
      .query(
        "UPDATE skill_proposals SET status='rejected',decision=? WHERE id=? AND project_id IS ? AND status='proposed'",
      )
      .run(reason, proposalId, projectId);
    if (!result.changes) throw new ConflictError("Proposal missing or already decided");
  }
}
