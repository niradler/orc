import type { Database } from "bun:sqlite";
import { ConflictError, NotFoundError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import {
  SESSION_MESSAGE_HOP_LIMIT,
  SESSION_MESSAGE_HOURLY_LIMIT,
  SESSION_MESSAGE_RETENTION_MS,
  type SessionMessage,
  type SessionMessageCreate,
  SessionMessageSchema,
  type SessionMessageSender,
  sessionMessageBackend,
  sessionMessageHookSupported,
} from "@orc/core/session-messages";
import { AuditLog, installAudit } from "./audit.js";

type MessageRow = {
  id: string;
  project_id: string | null;
  target_session_id: string;
  target_native_id: string | null;
  target_backend: string;
  sender_kind: string;
  sender_session_id: string | null;
  sender_native_id: string | null;
  sender_backend: string | null;
  sender_label: string;
  sender_key: string;
  body: string;
  position: number;
  hop: number;
  state: string;
  delivered_via: string | null;
  delivery_error: string | null;
  request_id: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
};

type GatewayRow = {
  id: string;
  project_id: string | null;
  backend: string;
  runtime_session_id: string | null;
  status: string;
  title: string | null;
};

export type ClaimOptions = {
  limit?: number;
};

function toMessage(row: MessageRow): SessionMessage {
  return SessionMessageSchema.parse({
    ...row,
    sender_kind: row.sender_kind,
    state: row.state,
    delivered_via: row.delivered_via,
  });
}

export class SessionMessageStore {
  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    installAudit(db);
    db.exec(`CREATE TABLE IF NOT EXISTS session_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      target_session_id TEXT NOT NULL,
      target_native_id TEXT,
      target_backend TEXT NOT NULL,
      sender_kind TEXT NOT NULL,
      sender_session_id TEXT,
      sender_native_id TEXT,
      sender_backend TEXT,
      sender_label TEXT NOT NULL,
      sender_key TEXT NOT NULL,
      body TEXT NOT NULL,
      position INTEGER NOT NULL,
      hop INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      delivered_via TEXT,
      delivery_error TEXT,
      request_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS session_messages_target_idx
      ON session_messages(target_session_id, state, position);
    CREATE INDEX IF NOT EXISTS session_messages_native_idx
      ON session_messages(target_native_id, target_backend, state, position);
    CREATE UNIQUE INDEX IF NOT EXISTS session_messages_request_idx
      ON session_messages(sender_key, request_id) WHERE request_id IS NOT NULL;`);
  }

  private audit(message: SessionMessage, action: string): void {
    new AuditLog(this.db, { now: this.now }).record({
      action,
      subject_ids: [message.id],
      project_id: message.project_id,
      session_id: message.sender_session_id,
      snapshot: {
        target_session_id: message.target_session_id,
        target_backend: message.target_backend,
        state: message.state,
        hop: message.hop,
        delivered_via: message.delivered_via,
      },
    });
  }

  private prune(): void {
    this.db
      .query(
        "DELETE FROM session_messages WHERE state IN ('delivered','cancelled','failed','interrupted') AND created_at < ?",
      )
      .run(this.now() - SESSION_MESSAGE_RETENTION_MS);
  }

  private resolveSession(identifier: string, backend?: string): GatewayRow | null {
    const rows = this.db
      .query<GatewayRow, [string]>(
        `SELECT id, project_id, backend, runtime_session_id, status, title
         FROM gateway_sessions
         WHERE id = ?1 OR runtime_session_id = ?1
         ORDER BY CASE WHEN status = 'stopped' THEN 1 ELSE 0 END,
                  COALESCE(last_activity_at, 0) DESC
         LIMIT 10`,
      )
      .all(identifier);
    const requested = backend ? sessionMessageBackend(backend) : null;
    const matched = requested
      ? rows.filter((row) => sessionMessageBackend(row.backend) === requested)
      : rows;
    if (matched.length > 1) {
      const live = matched.filter((row) => row.status !== "stopped");
      if (live.length === 1) return live[0] ?? null;
      throw new ConflictError(
        "Session id matches more than one agent session; pass the backend to choose one",
      );
    }
    return matched[0] ?? null;
  }

  private senderKey(sender: SessionMessageSender): string {
    return sender.session_id ?? sender.label;
  }

  private hopFor(sender: SessionMessageSender): number {
    if (sender.kind !== "session" || !sender.session_id) return 0;
    // The chain continues from the highest hop this sender already received.
    const row = this.db
      .query<{ hop: number | null }, [string]>(
        `SELECT MAX(hop) AS hop FROM session_messages
         WHERE target_session_id = ? AND sender_kind = 'session'
           AND state IN ('delivered','delivering') AND hop > 0`,
      )
      .get(sender.session_id);
    const next = (row?.hop ?? 0) + 1;
    if (next > SESSION_MESSAGE_HOP_LIMIT)
      throw new ConflictError(
        `Message hop limit (${SESSION_MESSAGE_HOP_LIMIT}) reached; ask a human to relay this request`,
      );
    return next;
  }

  private checkRate(sender: SessionMessageSender, targetSessionId: string): void {
    // Human and channel relays are not part of an agent-to-agent conversation.
    if (sender.kind !== "session") return;
    const key = this.senderKey(sender);
    const count = this.db
      .query<{ count: number }, [string, string, number]>(
        `SELECT COUNT(*) AS count FROM session_messages
         WHERE sender_key = ? AND target_session_id = ? AND created_at >= ?`,
      )
      .get(key, targetSessionId, this.now() - 60 * 60 * 1000);
    if ((count?.count ?? 0) >= SESSION_MESSAGE_HOURLY_LIMIT)
      throw new ConflictError(
        `Hourly message limit (${SESSION_MESSAGE_HOURLY_LIMIT}) reached for this sender and session`,
      );
  }

  /** Resolve a caller's native or ORC session id to the stored live-session identity. */
  resolveSender(
    identifier: string,
    kind: SessionMessageSender["kind"] = "session",
    label?: string,
  ): SessionMessageSender {
    const row = this.resolveSession(identifier);
    if (!row)
      throw new NotFoundError(
        "Session",
        `${identifier}. Start it, let ORC discover it, then retry`,
      );
    return {
      kind,
      session_id: row.id,
      native_id: row.runtime_session_id,
      backend: sessionMessageBackend(row.backend),
      label:
        label ??
        `session ${row.id} (${sessionMessageBackend(row.backend)}${row.title ? `, ${row.title}` : ""})`.slice(
          0,
          200,
        ),
    };
  }

  target(identifier: string, backend?: string): GatewayRow {
    const row = this.resolveSession(identifier, backend);
    if (!row)
      throw new NotFoundError(
        "Session",
        `${identifier}. Start it, let ORC discover it, then retry`,
      );
    return row;
  }

  create(input: SessionMessageCreate, sender: SessionMessageSender): SessionMessage {
    const normalizedSender = {
      ...sender,
      backend: sender.backend ? sessionMessageBackend(sender.backend) : sender.backend,
    };
    return this.db
      .transaction(() => {
        const target = this.resolveSession(input.session_id, input.backend);
        if (!target)
          throw new NotFoundError(
            "Session",
            `${input.session_id}. Start it, let ORC discover it, then retry`,
          );
        if (!target.runtime_session_id)
          throw new ConflictError(
            "That session has no agent session id yet; retry after it registers",
          );
        if (target.status !== "stopped" && !sessionMessageHookSupported(target.backend))
          throw new ConflictError(
            `${sessionMessageBackend(target.backend)} sessions cannot receive messages while running; send after the session ends`,
          );
        const senderKey = this.senderKey(normalizedSender);
        if (input.request_id) {
          const existing = this.db
            .query<MessageRow, [string, string]>(
              "SELECT * FROM session_messages WHERE sender_key = ? AND request_id = ?",
            )
            .get(senderKey, input.request_id);
          if (existing) {
            const message = toMessage(existing);
            if (message.target_session_id !== target.id)
              throw new ConflictError("Request id was already used for a different session");
            return message;
          }
        }
        this.prune();
        this.checkRate(normalizedSender, target.id);
        const hop = this.hopFor(normalizedSender);
        const position =
          this.db
            .query<{ position: number | null }, [string]>(
              "SELECT MAX(position) AS position FROM session_messages WHERE target_session_id = ? AND state = 'queued'",
            )
            .get(target.id)?.position ?? -1;
        const now = this.now();
        const message: SessionMessage = SessionMessageSchema.parse({
          id: ulid(),
          project_id: target.project_id,
          target_session_id: target.id,
          target_native_id: target.runtime_session_id,
          target_backend: sessionMessageBackend(target.backend),
          sender_kind: normalizedSender.kind,
          sender_session_id: normalizedSender.session_id ?? null,
          sender_native_id: normalizedSender.native_id ?? null,
          sender_backend: normalizedSender.backend ?? null,
          sender_label: normalizedSender.label,
          body: input.body,
          position: position + 1,
          hop,
          state: "queued",
          delivered_via: null,
          delivery_error: null,
          request_id: input.request_id ?? null,
          created_at: now,
          updated_at: now,
          delivered_at: null,
        });
        this.db
          .query(
            `INSERT INTO session_messages
             (id,project_id,target_session_id,target_native_id,target_backend,sender_kind,
              sender_session_id,sender_native_id,sender_backend,sender_label,sender_key,body,
              position,hop,state,delivered_via,delivery_error,request_id,created_at,updated_at,delivered_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            message.id,
            message.project_id,
            message.target_session_id,
            message.target_native_id,
            message.target_backend,
            message.sender_kind,
            message.sender_session_id,
            message.sender_native_id,
            message.sender_backend,
            message.sender_label,
            senderKey,
            message.body,
            message.position,
            message.hop,
            message.state,
            message.delivered_via,
            message.delivery_error,
            message.request_id,
            message.created_at,
            message.updated_at,
            message.delivered_at,
          );
        this.audit(message, "session_message.created");
        return message;
      })
      .immediate();
  }

  get(id: string): SessionMessage {
    const row = this.db
      .query<MessageRow, [string]>("SELECT * FROM session_messages WHERE id = ?")
      .get(id);
    if (!row) throw new NotFoundError("Session message", id);
    return toMessage(row);
  }

  list(sessionId: string, limit = 100): SessionMessage[] {
    return this.db
      .query<MessageRow, [string, number]>(
        `SELECT * FROM session_messages WHERE target_session_id = ?
         ORDER BY CASE state WHEN 'queued' THEN 0 WHEN 'delivering' THEN 1 ELSE 2 END,
                  position, created_at DESC
         LIMIT ?`,
      )
      .all(sessionId, Math.min(Math.max(limit, 1), 500))
      .map(toMessage);
  }

  queued(sessionId: string): SessionMessage[] {
    return this.db
      .query<MessageRow, [string]>(
        "SELECT * FROM session_messages WHERE target_session_id = ? AND state = 'queued' ORDER BY position, created_at",
      )
      .all(sessionId)
      .map(toMessage);
  }

  cancel(id: string): SessionMessage {
    return this.db
      .transaction(() => {
        const message = this.get(id);
        if (message.state === "cancelled") return message;
        if (message.state !== "queued")
          throw new ConflictError("Only a queued message can be cancelled");
        const now = this.now();
        this.db
          .query(
            "UPDATE session_messages SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'queued'",
          )
          .run(now, id);
        const cancelled = this.get(id);
        this.audit(cancelled, "session_message.cancelled");
        return cancelled;
      })
      .immediate();
  }

  move(id: string, direction: "up" | "down"): SessionMessage {
    return this.db
      .transaction(() => {
        const message = this.get(id);
        if (message.state !== "queued") throw new ConflictError("Only a queued message can move");
        const rows = this.queued(message.target_session_id);
        const index = rows.findIndex((row) => row.id === id);
        const neighbour = rows[index + (direction === "up" ? -1 : 1)];
        if (index < 0 || !neighbour) return message;
        const now = this.now();
        this.db
          .query("UPDATE session_messages SET position = ?, updated_at = ? WHERE id = ?")
          .run(neighbour.position, now, message.id);
        this.db
          .query("UPDATE session_messages SET position = ?, updated_at = ? WHERE id = ?")
          .run(message.position, now, neighbour.id);
        return this.get(id);
      })
      .immediate();
  }

  /** Atomically take queued messages for the next safe delivery point of a session. */
  claim(
    targetBackend: string,
    targetNativeId: string,
    options: ClaimOptions = {},
  ): SessionMessage[] {
    return this.db
      .transaction(() => {
        const rows = this.db
          .query<MessageRow, [string, string, number]>(
            `SELECT * FROM session_messages
             WHERE target_native_id = ? AND target_backend = ? AND state = 'queued'
             ORDER BY position, created_at LIMIT ?`,
          )
          .all(targetNativeId, sessionMessageBackend(targetBackend), options.limit ?? 10);
        const now = this.now();
        for (const row of rows)
          this.db
            .query(
              "UPDATE session_messages SET state = 'delivering', updated_at = ? WHERE id = ? AND state = 'queued'",
            )
            .run(now, row.id);
        return rows.map((row) => toMessage({ ...row, state: "delivering" }));
      })
      .immediate();
  }

  /** Claim by ORC session id, for resuming a stopped session whose chat runtime differs. */
  claimTarget(sessionId: string, options: ClaimOptions = {}): SessionMessage[] {
    return this.db
      .transaction(() => {
        const rows = this.db
          .query<MessageRow, [string, number]>(
            `SELECT * FROM session_messages
             WHERE target_session_id = ? AND state = 'queued'
             ORDER BY position, created_at LIMIT ?`,
          )
          .all(sessionId, options.limit ?? 10);
        const now = this.now();
        for (const row of rows)
          this.db
            .query(
              "UPDATE session_messages SET state = 'delivering', updated_at = ? WHERE id = ? AND state = 'queued'",
            )
            .run(now, row.id);
        return rows.map((row) => toMessage({ ...row, state: "delivering" }));
      })
      .immediate();
  }

  deliver(ids: string[], via: SessionMessage["delivered_via"]): void {
    if (!ids.length || !via) return;
    const now = this.now();
    this.db
      .transaction(() => {
        for (const id of ids)
          this.db
            .query(
              "UPDATE session_messages SET state = 'delivered', delivered_via = ?, delivered_at = ?, updated_at = ? WHERE id = ? AND state = 'delivering'",
            )
            .run(via, now, now, id);
      })
      .immediate();
  }

  failed(ids: string[], error: string): void {
    if (!ids.length) return;
    const now = this.now();
    this.db
      .transaction(() => {
        for (const id of ids)
          this.db
            .query(
              "UPDATE session_messages SET state = 'failed', delivery_error = ?, updated_at = ? WHERE id = ? AND state IN ('queued','delivering')",
            )
            .run(error.slice(0, 2000), now, id);
      })
      .immediate();
  }

  interrupted(ids: string[], error = "ORC restarted while delivering this message"): void {
    if (!ids.length) return;
    const now = this.now();
    this.db
      .transaction(() => {
        for (const id of ids)
          this.db
            .query(
              "UPDATE session_messages SET state = 'interrupted', delivery_error = ?, updated_at = ? WHERE id = ? AND state = 'delivering'",
            )
            .run(error, now, id);
      })
      .immediate();
  }

  /** Mark rows abandoned by a previous ORC process; they are never retried. */
  interruptInFlight(): number {
    return this.db
      .query(
        "UPDATE session_messages SET state = 'interrupted', delivery_error = 'ORC restarted while delivering this message', updated_at = ? WHERE state = 'delivering'",
      )
      .run(this.now()).changes;
  }

  /** Destinations with queued messages, for idle or exited session delivery. */
  pendingTargets(): string[] {
    return this.db
      .query<{ target_session_id: string }, []>(
        "SELECT DISTINCT target_session_id FROM session_messages WHERE state = 'queued'",
      )
      .all()
      .map((row) => row.target_session_id);
  }
}
