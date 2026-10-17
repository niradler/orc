import type { Database } from "bun:sqlite";
import { ConflictError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { AuditLog } from "./audit.js";
import { WikiStore } from "./wiki.js";

export const DIGEST_JOB_NAME = "orc-knowledge-digest";
export const DIGEST_COMMAND = "__orc_knowledge_digest__";
export function installDigest(sqlite: Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS knowledge_digests (
    project_key TEXT PRIMARY KEY, project_id TEXT, audit_cursor INTEGER NOT NULL DEFAULT 0,
    session_cursor INTEGER NOT NULL DEFAULT 0, token TEXT, expires_at INTEGER,
    audit_end INTEGER, session_end INTEGER
  );`);
  sqlite
    .query(`INSERT OR IGNORE INTO jobs(id,name,description,command,skill_name,trigger_type,cron_expr,timeout_secs,enabled)
    VALUES(?,?,'Consolidate new knowledge daily',?,'orc-wiki','cron','0 3 * * *',1800,1)`)
    .run(ulid(), DIGEST_JOB_NAME, DIGEST_COMMAND);
}
export type DigestInput = {
  token: string;
  project_id: string | null;
  project: string | null;
  memories: { name: string; description: string; content: string; priority: number | null }[];
  events: { action: string; subject_ids: string; result_ids: string; note: string | null }[];
  sessions: { summary: string | null; agent: string }[];
  wiki: ReturnType<WikiStore["list"]>;
};
export class DigestStore {
  constructor(private readonly sqlite: Database) {}
  hasChanges(projectId: string | null): boolean {
    const key = projectId === null ? "global:" : `project:${projectId}`;
    const state = this.sqlite
      .query<
        {
          audit_cursor: number;
          session_cursor: number;
          token: string | null;
          expires_at: number | null;
        },
        [string]
      >(
        "SELECT audit_cursor,session_cursor,token,expires_at FROM knowledge_digests WHERE project_key=?",
      )
      .get(key);
    if (state?.token && (state.expires_at ?? 0) > Date.now() / 1000) return false;
    return Boolean(
      this.sqlite
        .query(
          "SELECT 1 FROM audit_log WHERE project_id IS ? AND rowid>? AND entity_type='memory' UNION SELECT 1 FROM sessions WHERE project_id IS ? AND rowid>? AND agent NOT IN ('orc-wiki','runner') LIMIT 1",
        )
        .get(projectId, state?.audit_cursor ?? 0, projectId, state?.session_cursor ?? 0),
    );
  }
  scopes(): (string | null)[] {
    return [
      null,
      ...this.sqlite
        .query<{ id: string }, []>("SELECT id FROM projects WHERE status='active'")
        .all()
        .map((row) => row.id),
    ];
  }
  claim(projectId: string | null): DigestInput | null {
    const projectKey = projectId === null ? "global:" : `project:${projectId}`;
    return this.sqlite.transaction(() => {
      this.sqlite
        .query("INSERT OR IGNORE INTO knowledge_digests(project_key,project_id) VALUES(?,?)")
        .run(projectKey, projectId);
      const state = this.sqlite
        .query<
          {
            audit_cursor: number;
            session_cursor: number;
            token: string | null;
            expires_at: number | null;
          },
          [string]
        >("SELECT * FROM knowledge_digests WHERE project_key=?")
        .get(projectKey);
      if (!state) throw new Error("Digest state was not created");
      if (state.token && (state.expires_at ?? 0) > Date.now() / 1000) return null;
      const events = this.sqlite
        .query<
          {
            rowid: number;
            action: string;
            subject_ids: string;
            result_ids: string;
            note: string | null;
          },
          [string | null, number]
        >(
          "SELECT rowid,action,subject_ids,result_ids,note FROM audit_log WHERE project_id IS ? AND rowid>? AND entity_type='memory' ORDER BY rowid LIMIT 100",
        )
        .all(projectId, state.audit_cursor);
      const sessions = this.sqlite
        .query<{ rowid: number; summary: string | null; agent: string }, [string | null, number]>(
          "SELECT rowid,summary,agent FROM sessions WHERE project_id IS ? AND rowid>? AND agent NOT IN ('orc-wiki','runner') ORDER BY rowid LIMIT 30",
        )
        .all(projectId, state.session_cursor);
      if (!events.length && !sessions.length) return null;
      const token = crypto.randomUUID();
      this.sqlite
        .query(
          "UPDATE knowledge_digests SET token=?,expires_at=unixepoch()+900,audit_end=?,session_end=? WHERE project_key=?",
        )
        .run(
          token,
          events.at(-1)?.rowid ?? state.audit_cursor,
          sessions.at(-1)?.rowid ?? state.session_cursor,
          projectKey,
        );
      // Memory audit entries name the memory in subject_ids; result_ids are change ids.
      const names = new Set(events.flatMap((event) => JSON.parse(event.subject_ids) as string[]));
      const memories =
        projectId === null
          ? []
          : [...names].flatMap((name) => {
              const memory = this.sqlite
                .query<DigestInput["memories"][number], [string, string]>(
                  "SELECT name,description,content,priority FROM memories WHERE project_id=? AND name=?",
                )
                .get(projectId, name);
              return memory ? [memory] : [];
            });
      const project =
        projectId === null
          ? null
          : (this.sqlite
              .query<{ name: string }, [string]>("SELECT name FROM projects WHERE id=?")
              .get(projectId)?.name ?? null);
      return {
        token,
        project_id: projectId,
        project,
        memories,
        events,
        sessions: sessions.map((s) => ({
          summary: s.summary?.slice(0, 1000) ?? null,
          agent: s.agent,
        })),
        wiki: new WikiStore(this.sqlite).list(projectId).slice(0, 100),
      };
    })();
  }
  complete(token: string, outcome: "applied" | "no_change", note: string): void {
    this.sqlite.transaction(() => {
      const state = this.sqlite
        .query<{ project_key: string; project_id: string | null; expires_at: number }, [string]>(
          "SELECT * FROM knowledge_digests WHERE token=?",
        )
        .get(token);
      if (!state || state.expires_at <= Date.now() / 1000)
        throw new ConflictError("Digest claim expired or already completed");
      this.sqlite
        .query(
          "UPDATE knowledge_digests SET audit_cursor=audit_end,session_cursor=session_end,token=NULL,expires_at=NULL WHERE token=?",
        )
        .run(token);
      new AuditLog(this.sqlite).record({
        action: "digest.completed",
        project_id: state.project_id,
        actor: "orc-wiki",
        subject_ids: [],
        result_ids: [token],
        note: `${outcome}: ${note}`,
      });
    })();
  }
  fail(token: string, note: string): void {
    this.sqlite.transaction(() => {
      const state = this.sqlite
        .query<{ project_id: string | null }, [string]>(
          "SELECT project_id FROM knowledge_digests WHERE token=?",
        )
        .get(token);
      if (!state) return;
      this.sqlite
        .query("UPDATE knowledge_digests SET token=NULL,expires_at=NULL WHERE token=?")
        .run(token);
      new AuditLog(this.sqlite).record({
        action: "digest.failed",
        project_id: state.project_id,
        actor: "orc-wiki",
        subject_ids: [],
        note,
      });
    })();
  }
  completed(token: string): boolean {
    return Boolean(
      this.sqlite
        .query(
          "SELECT 1 FROM audit_log a, json_each(a.result_ids) result WHERE a.action='digest.completed' AND result.value=? LIMIT 1",
        )
        .get(token),
    );
  }
}
