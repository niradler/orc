import type { Database } from "bun:sqlite";
import {
  type ChatProviderRef,
  type ChatThread,
  type ChatTurnLease,
  parseChatThread,
} from "@orc/core/chat";
import { ConflictError } from "@orc/core/errors";

type ChatSummary = Pick<ChatThread, "id" | "title" | "updatedAt"> & {
  agent: string | null;
  backend: string | null;
  runtimeId: string | null;
  sourceId: string | null;
  host: string | null;
  projectId: string | null;
  spawnedFrom: string | null;
  resumed: number;
};

export function installChat(sqlite: Database): void {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS chat_threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)",
  );
  sqlite.exec("CREATE INDEX IF NOT EXISTS chat_threads_updated_idx ON chat_threads(updated_at)");
}
export class ChatStore {
  constructor(private readonly db: Database) {}
  get(id: string): ChatThread | null {
    const row = this.db
      .query<{ data: string }, [string]>("SELECT data FROM chat_threads WHERE id = ?")
      .get(id);
    return row ? parseChatThread(JSON.parse(row.data)) : null;
  }
  list(): ChatSummary[] {
    return this.db
      .query<ChatSummary, []>(
        `SELECT id, title, updated_at AS updatedAt,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.config.agent') = 'text'
              THEN json_extract(data, '$.config.agent') END
          END AS agent,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.backend') = 'text'
              THEN json_extract(data, '$.backend') END
          END AS backend,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.runtimeId') = 'text'
              THEN json_extract(data, '$.runtimeId') END
          END AS runtimeId,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.sourceId') = 'text'
              THEN json_extract(data, '$.sourceId') END
          END AS sourceId,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.host') = 'text'
              THEN json_extract(data, '$.host') END
          END AS host,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.projectId') = 'text'
              THEN json_extract(data, '$.projectId') END
          END AS projectId,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.spawnedBy.sessionId') = 'text'
              THEN json_extract(data, '$.spawnedBy.sessionId') END
          END AS spawnedFrom,
          CASE WHEN json_valid(data) THEN json_type(data, '$.importedMessages') IS NOT NULL ELSE 0 END
            AS resumed
        FROM chat_threads ORDER BY updated_at DESC`,
      )
      .all();
  }
  byRuntime(backend: string, host: string | null, runtimeId: string): ChatThread[] {
    return this.db
      .query<{ id: string }, [string, string, string]>(
        `SELECT id FROM chat_threads WHERE json_valid(data)
          AND json_extract(data, '$.runtimeId')=? AND json_extract(data, '$.backend')=?
          AND coalesce(json_extract(data, '$.host'), '')=?`,
      )
      .all(runtimeId, backend, host ?? "")
      .flatMap((row) => this.get(row.id) ?? []);
  }
  bySource(sourceId: string): ChatThread | null {
    const row = this.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM chat_threads WHERE json_valid(data)
          AND json_extract(data, '$.sourceId')=? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(sourceId);
    return row ? this.get(row.id) : null;
  }
  children(sessionIds: string[]): ChatThread[] {
    if (!sessionIds.length) return [];
    return this.db
      .query<{ id: string }, string[]>(
        `SELECT id FROM chat_threads WHERE json_valid(data)
          AND json_extract(data, '$.spawnedBy.sessionId') IN (${sessionIds.map(() => "?").join(",")})
          ORDER BY updated_at DESC LIMIT 200`,
      )
      .all(...sessionIds)
      .flatMap((row) => this.get(row.id) ?? []);
  }
  pendingSpawns(): ChatThread[] {
    return this.db
      .query<{ id: string }, []>(
        `SELECT id FROM chat_threads WHERE json_valid(data)
          AND json_extract(data, '$.spawnedBy.prompt') IS NOT NULL ORDER BY updated_at ASC LIMIT 50`,
      )
      .all()
      .flatMap((row) => this.get(row.id) ?? []);
  }
  byMessage(messageId: string): ChatThread | null {
    const row = this.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM chat_threads WHERE json_valid(data) AND EXISTS (SELECT 1 FROM
          json_each(data,'$.messages') WHERE json_extract(value,'$.id')=? AND
          json_extract(value,'$.role')='user') ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(messageId);
    return row ? this.get(row.id) : null;
  }
  /** Records a source session without rewriting the whole row, so a read path
   *  cannot clobber a turn that saved concurrently. */
  setSourceId(id: string, sourceId: string): void {
    this.db
      .query(
        `UPDATE chat_threads SET data = json_set(data, '$.sourceId', ?)
          WHERE id = ? AND json_valid(data)
            AND coalesce(json_extract(data, '$.sourceId'), '') = ''`,
      )
      .run(sourceId, id);
  }
  /** Write-through of the resumable identity: pins runtimeId and the provider
    ref history mid-turn without rewriting messages, so a crash before the
    terminal result can never orphan the thread from its native session. The
    runId guard keeps a late write of a dead turn from clobbering a newer one. */
  setRuntimeRef(
    id: string,
    runId: string,
    epoch: number,
    runtimeId: string | null,
    providerRefs: ChatProviderRef[],
  ): void {
    this.db
      .query(
        `UPDATE chat_threads SET data = json_set(data, '$.runtimeId', json(?), '$.providerRefs', json(?))
          WHERE id = ? AND json_valid(data)
            AND json_extract(data, '$.turn.runId') = ?
            AND json_extract(data, '$.turn.epoch') = ?
            AND json_extract(data, '$.turn.status') = 'running'`,
      )
      .run(JSON.stringify(runtimeId), JSON.stringify(providerRefs), id, runId, epoch);
  }
  /** Debounced liveness beat for a running lease; never resurrects a terminal one. */
  heartbeatTurnLease(id: string, runId: string, epoch: number, at: number): void {
    this.db
      .query(
        `UPDATE chat_threads SET data = json_set(data, '$.turn.lastHeartbeatAt', ?)
          WHERE id = ? AND json_valid(data)
            AND json_extract(data, '$.turn.runId') = ?
            AND json_extract(data, '$.turn.epoch') = ?
            AND json_extract(data, '$.turn.status') = 'running'`,
      )
      .run(at, id, runId, epoch);
  }
  /** Daemon-exit flush for a turn that would not finish: persist the resumable
    identity and the lease as-is. The lease stays `running` on purpose — the
    next boot's reconcile records the interruption exactly once. */
  persistTurnForShutdown(
    id: string,
    runId: string,
    epoch: number,
    runtimeId: string | null,
    providerRefs: ChatProviderRef[],
    turn: ChatTurnLease,
  ): void {
    this.db
      .query(
        `UPDATE chat_threads SET data = json_set(data, '$.runtimeId', json(?), '$.providerRefs', json(?), '$.turn', json(?))
          WHERE id = ? AND json_valid(data)
            AND json_extract(data, '$.turn.runId') = ?
            AND json_extract(data, '$.turn.epoch') = ?
            AND json_extract(data, '$.turn.status') = 'running'`,
      )
      .run(
        JSON.stringify(runtimeId),
        JSON.stringify(providerRefs),
        JSON.stringify(turn),
        id,
        runId,
        epoch,
      );
  }
  /**
   * Claims the thread for a turn and returns the lease epoch this turn owns.
   * The write is a strict compare-and-set against the epoch the caller observed
   * on the thread it loaded (`expectedEpoch`, 0 for a thread with no lease), so
   * two daemons — or a resurrected process — can never both acquire the same
   * state: the loser sees the stored epoch had moved and gets no turn. That is
   * what keeps two turns off one native session.
   *
   * The caller must have established that no live turn owns the observed lease
   * (the busy check): the CAS promises one writer per observed state, not that
   * the observed state was safe to take.
   */
  claimTurn(thread: ChatThread, lease: Omit<ChatTurnLease, "epoch">, expectedEpoch = 0): number {
    const existing = this.get(thread.id);
    const epoch = expectedEpoch + 1;
    const claimed: ChatThread = { ...thread, turn: { ...lease, epoch } };
    if (!existing) {
      if (expectedEpoch !== 0)
        throw new ConflictError(
          "Another turn claimed this conversation; this message was not started.",
          "TURN_SUPERSEDED",
        );
      this.save(claimed);
    } else {
      const result = this.db
        .query(
          `UPDATE chat_threads SET title = ?, updated_at = ?, data = ?
            WHERE id = ? AND json_valid(data)
              AND coalesce(json_extract(data, '$.turn.epoch'), 0) = ?`,
        )
        .run(claimed.title, claimed.updatedAt, JSON.stringify(claimed), claimed.id, expectedEpoch);
      if (result.changes === 0)
        throw new ConflictError(
          "Another turn claimed this conversation; this message was not started.",
          "TURN_SUPERSEDED",
        );
    }
    thread.turn = claimed.turn;
    return epoch;
  }
  /**
   * Full thread save fenced by the turn this writer owns: the row must still
   * hold this runId, and its epoch must not have advanced past this turn. A
   * resurrected process or a second daemon on the same database therefore
   * cannot overwrite a newer turn, and a stale turn cannot finalize into one.
   * A missing row is inserted: a conversation created by this writer has no
   * lease to fence against.
   */
  saveTurn(thread: ChatThread, epoch: number): void {
    const runId = thread.turn?.runId;
    if (!runId) throw new Error("saveTurn requires the turn's runId");
    const result = this.db
      .query(
        `UPDATE chat_threads SET title = ?, updated_at = ?, data = ?
          WHERE id = ? AND json_valid(data)
            AND json_extract(data, '$.turn.runId') = ?
            AND coalesce(json_extract(data, '$.turn.epoch'), 0) <= ?`,
      )
      .run(thread.title, thread.updatedAt, JSON.stringify(thread), thread.id, runId, epoch);
    if (result.changes > 0) return;
    const exists = this.db
      .query<{ id: string }, [string]>("SELECT id FROM chat_threads WHERE id = ?")
      .get(thread.id);
    if (exists)
      throw new ConflictError(
        "Another turn claimed this conversation; this response was not saved.",
        "TURN_SUPERSEDED",
      );
    this.save(thread);
  }
  save(thread: ChatThread): void {
    this.db
      .query(
        "INSERT INTO chat_threads (id, title, updated_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, data=excluded.data",
      )
      .run(thread.id, thread.title, thread.updatedAt, JSON.stringify(thread));
  }
  relatedSessionIds(ids: string[], paths: string[]): string[] {
    if (!ids.length && !paths.length) return [];
    type Row = {
      id: string;
      runtime_session_id: string | null;
      parent_session_id: string | null;
      backend: string;
      execution_host: string | null;
    };
    const marks = (values: unknown[]) => values.map(() => "?").join(",");
    const columns = "id, runtime_session_id, parent_session_id, backend, execution_host";
    const touched = this.db
      .query<Row, string[]>(
        `SELECT ${columns} FROM gateway_sessions WHERE id IN (${marks(ids)}) OR transcript_path IN (${marks(paths)})`,
      )
      .all(...ids, ...paths);
    const parentIds = touched.flatMap((row) => row.parent_session_id ?? []);
    const parents = this.db
      .query<Row, string[]>(
        `SELECT ${columns} FROM gateway_sessions WHERE runtime_session_id IN (${marks(parentIds)})`,
      )
      .all(...parentIds)
      .filter((parent) =>
        touched.some(
          (row) =>
            row.parent_session_id === parent.runtime_session_id && row.backend === parent.backend,
        ),
      );
    const rows = [...touched, ...parents];
    const sources = rows.map((row) => row.id);
    const runtimes = rows.flatMap((row) => row.runtime_session_id ?? []);
    const threads = this.db
      .query<
        {
          id: string;
          sourceId: string | null;
          runtimeId: string | null;
          backend: string | null;
          host: string | null;
        },
        string[]
      >(
        `SELECT id, json_extract(data, '$.sourceId') AS sourceId, json_extract(data, '$.runtimeId') AS runtimeId,
           json_extract(data, '$.backend') AS backend, json_extract(data, '$.host') AS host
         FROM chat_threads WHERE json_valid(data)
           AND (json_extract(data, '$.sourceId') IN (${marks(sources)}) OR json_extract(data, '$.runtimeId') IN (${marks(runtimes)}))`,
      )
      .all(...sources, ...runtimes)
      .filter(
        (thread) =>
          (thread.sourceId !== null && sources.includes(thread.sourceId)) ||
          rows.some(
            (row) =>
              row.runtime_session_id === thread.runtimeId &&
              (thread.backend === row.backend || thread.backend === `${row.backend}-cli`) &&
              (thread.host ?? null) === row.execution_host,
          ),
      );
    return [
      ...rows.flatMap((row) => [row.id, row.runtime_session_id, row.parent_session_id]),
      ...threads.map((thread) => thread.id),
    ].filter((id): id is string => !!id);
  }
}
