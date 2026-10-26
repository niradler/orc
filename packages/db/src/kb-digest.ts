import type { Database } from "bun:sqlite";
import { ConflictError } from "@orc/core/errors";
import { AuditLog } from "./audit.js";

/** A digest's job runs this sentinel command; the runner starts the KB's digest instead of a shell. */
export const KB_DIGEST_COMMAND_PREFIX = "__orc_kb_digest__:";
export const kbDigestCommand = (kbId: string) => `${KB_DIGEST_COMMAND_PREFIX}${kbId}`;
export const kbDigestKbId = (command: string) =>
  command.startsWith(KB_DIGEST_COMMAND_PREFIX)
    ? command.slice(KB_DIGEST_COMMAND_PREFIX.length)
    : null;
export const kbDigestJobName = (kbId: string) => `kb-digest:${kbId}`;
/** Agent name the digest's own sessions are recorded under, so a run never digests itself. */
export const KB_DIGEST_AGENT = "kb-digest";

export type KbDigestRow = {
  kb_id: string;
  instructions: string;
  backend: string;
  job_id: string;
  last_success_at: number | null;
  token: string | null;
  claimed_at: number | null;
  expires_at: number | null;
  session_id: string | null;
  last_status: string | null;
  last_note: string | null;
  last_run_at: number | null;
  last_session_id: string | null;
  created_at: number;
  updated_at: number;
};

export type KbDigestClaim = {
  token: string;
  kb: {
    id: string;
    name: string;
    description: string;
    project_id: string | null;
    project: string | null;
  };
  instructions: string;
  backend: string;
  /** Start of the last completed run (ms), or null on the first run. */
  since: number | null;
  comments: {
    id: string;
    document_id: string | null;
    document_title: string | null;
    body: string;
    author: string;
    created_at: number;
  }[];
  /** Summaries of sessions in the KB's scope since the last completed run, oldest first. */
  sessions: { id: string; agent: string; summary: string; created_at: number }[];
};

type KbHead = { id: string; name: string; description: string; project_id: string | null };

/**
 * Claim, completion and failure of KB digest runs. The claim is a token with an expiry; only
 * `complete` moves `last_success_at`, so a failed or abandoned run is retried from the same point.
 */
export class KbDigestStore {
  constructor(private readonly sqlite: Database) {}

  row(kbId: string): KbDigestRow | null {
    return this.sqlite
      .query<KbDigestRow, [string]>("SELECT * FROM kb_digests WHERE kb_id = ?")
      .get(kbId);
  }

  openCommentCount(kbId: string): number {
    return (
      this.sqlite
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM kb_comments WHERE kb_id = ? AND status = 'open'",
        )
        .get(kbId)?.n ?? 0
    );
  }

  /** Whether a scheduled run has anything to look at: open comments or new activity in scope. */
  hasNewInput(kbId: string): boolean {
    const digest = this.row(kbId);
    const kb = this.kb(kbId);
    if (!digest || !kb) return false;
    if (digest.last_success_at === null || this.openCommentCount(kbId) > 0) return true;
    const since = Math.floor(digest.last_success_at / 1000);
    return Boolean(
      this.sqlite
        .query(
          `SELECT 1 FROM audit_log WHERE project_id IS ? AND entity_type = 'memory' AND created_at >= ?
           UNION ALL
           SELECT 1 FROM sessions WHERE project_id IS ? AND created_at >= ? AND agent NOT IN (?, 'runner')
           LIMIT 1`,
        )
        .get(kb.project_id, since, kb.project_id, since, KB_DIGEST_AGENT),
    );
  }

  private kb(kbId: string): KbHead | null {
    return this.sqlite
      .query<KbHead, [string]>(
        "SELECT id, name, description, project_id FROM knowledge_bases WHERE id = ?",
      )
      .get(kbId);
  }

  /** Null when another run holds a live claim. */
  claim(kbId: string, ttlSecs: number): KbDigestClaim | null {
    return this.sqlite.transaction(() => {
      const digest = this.row(kbId);
      const kb = this.kb(kbId);
      if (!digest || !kb) throw new ConflictError("Knowledge base has no digest");
      const now = Date.now();
      if (digest.token && (digest.expires_at ?? 0) > now) return null;
      const token = crypto.randomUUID();
      this.sqlite
        .query(
          `UPDATE kb_digests SET token = ?, claimed_at = ?, expires_at = ?, session_id = NULL,
             last_status = 'running', last_note = NULL, last_run_at = ?, last_session_id = NULL
           WHERE kb_id = ?`,
        )
        .run(token, now, now + ttlSecs * 1000, now, kbId);
      const project =
        kb.project_id === null
          ? null
          : (this.sqlite
              .query<{ name: string }, [string]>("SELECT name FROM projects WHERE id = ?")
              .get(kb.project_id)?.name ?? null);
      const comments = this.sqlite
        .query<KbDigestClaim["comments"][number], [string]>(
          `SELECT c.id, c.document_id, d.title AS document_title, c.body, c.author, c.created_at
           FROM kb_comments c LEFT JOIN kb_documents d ON d.id = c.document_id
           WHERE c.kb_id = ? AND c.status = 'open' ORDER BY c.created_at, c.rowid LIMIT 100`,
        )
        .all(kbId);
      const sessions = this.sqlite
        .query<KbDigestClaim["sessions"][number], [string | null, number, string]>(
          `SELECT id, agent, substr(summary, 1, 2000) AS summary, created_at FROM (
             SELECT rowid, id, agent, summary, created_at FROM sessions
             WHERE project_id IS ? AND created_at >= ? AND agent NOT IN (?, 'runner')
               AND summary IS NOT NULL AND trim(summary) != ''
             ORDER BY created_at DESC, rowid DESC LIMIT 30
           ) ORDER BY created_at, rowid`,
        )
        .all(kb.project_id, Math.floor((digest.last_success_at ?? 0) / 1000), KB_DIGEST_AGENT);
      return {
        token,
        kb: { ...kb, project },
        instructions: digest.instructions,
        backend: digest.backend,
        since: digest.last_success_at,
        comments,
        sessions,
      };
    })();
  }

  attachSession(token: string, sessionId: string): void {
    this.sqlite
      .query("UPDATE kb_digests SET session_id = ?, last_session_id = ? WHERE token = ?")
      .run(sessionId, sessionId, token);
  }

  /** Called by the digest agent (digest_complete). Moves the watermark to the claim's start. */
  complete(token: string, outcome: "applied" | "no_change", note: string, actor: string): void {
    this.sqlite.transaction(() => {
      const digest = this.sqlite
        .query<KbDigestRow, [string]>("SELECT * FROM kb_digests WHERE token = ?")
        .get(token);
      if (!digest || (digest.expires_at ?? 0) <= Date.now())
        throw new ConflictError("Digest claim expired or already completed");
      this.sqlite
        .query(
          `UPDATE kb_digests SET last_success_at = claimed_at, token = NULL, expires_at = NULL,
             last_status = 'completed', last_note = ? WHERE token = ?`,
        )
        .run(`${outcome}: ${note}`, token);
      new AuditLog(this.sqlite).record({
        action: "kb.digest.completed",
        project_id: this.kb(digest.kb_id)?.project_id ?? null,
        actor,
        session_id: digest.session_id,
        subject_ids: [digest.kb_id],
        result_ids: [token],
        note: `${outcome}: ${note}`,
      });
    })();
  }

  fail(token: string, note: string): void {
    this.sqlite.transaction(() => {
      const digest = this.sqlite
        .query<KbDigestRow, [string]>("SELECT * FROM kb_digests WHERE token = ?")
        .get(token);
      if (!digest) return;
      this.sqlite
        .query(
          "UPDATE kb_digests SET token = NULL, expires_at = NULL, last_status = 'failed', last_note = ? WHERE token = ?",
        )
        .run(note, token);
      new AuditLog(this.sqlite).record({
        action: "kb.digest.failed",
        project_id: this.kb(digest.kb_id)?.project_id ?? null,
        actor: KB_DIGEST_AGENT,
        session_id: digest.session_id,
        subject_ids: [digest.kb_id],
        note,
      });
    })();
  }

  skipped(kbId: string, note: string): void {
    this.sqlite
      .query(
        "UPDATE kb_digests SET last_status = 'skipped', last_note = ?, last_run_at = ?, last_session_id = NULL WHERE kb_id = ? AND token IS NULL",
      )
      .run(note, Date.now(), kbId);
  }

  completed(token: string): boolean {
    return Boolean(
      this.sqlite
        .query(
          "SELECT 1 FROM audit_log a, json_each(a.result_ids) r WHERE a.action = 'kb.digest.completed' AND r.value = ? LIMIT 1",
        )
        .get(token),
    );
  }
}
