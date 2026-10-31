import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { loadConfig } from "@orc/core/config";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import {
  CommandResultSchema,
  type HumanRequest,
  HumanRequestInputSchema,
  HumanRequestSchema,
  HumanResponseSchema,
} from "@orc/core/human-requests";
import { ulid } from "@orc/core/ids";
import { RuleStore } from "./rules.js";

export class HumanRequestStore {
  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS human_requests (
      id TEXT PRIMARY KEY, origin_key TEXT UNIQUE NOT NULL, input_hash TEXT NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
      response TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      responded_at INTEGER, delivered_at INTEGER
    ); CREATE INDEX IF NOT EXISTS human_requests_pending ON human_requests(status,created_at);`);
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(human_requests)").all();
    for (const [name, type] of [
      ["delivery_error", "TEXT"],
      ["owner_id", "TEXT"],
      ["owner_heartbeat_at", "INTEGER"],
    ])
      if (!columns.some((column) => column.name === name))
        db.exec(`ALTER TABLE human_requests ADD COLUMN ${name} ${type}`);
    db.exec(`CREATE TABLE IF NOT EXISTS human_request_notifications (
      request_id TEXT NOT NULL, channel TEXT NOT NULL, destination TEXT NOT NULL,
      version INTEGER NOT NULL, can_reply INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
      leased_until INTEGER NOT NULL, PRIMARY KEY(request_id,channel,destination)
    )`);
  }

  reserveNotification(
    request: HumanRequest,
    channel: string,
    destination: string,
    canReply: boolean,
  ): boolean {
    return (
      this.db
        .query(`INSERT INTO human_request_notifications
      (request_id,channel,destination,version,can_reply,leased_until) VALUES (?,?,?,?,?,?)
      ON CONFLICT(request_id,channel,destination) DO UPDATE SET leased_until=excluded.leased_until
      WHERE sent=0 AND leased_until<=?`)
        .run(
          request.id,
          channel,
          destination,
          request.version,
          canReply ? 1 : 0,
          this.now() + 30000,
          this.now(),
        ).changes > 0
    );
  }

  notificationSent(id: string, channel: string, destination: string): void {
    this.db
      .query(
        "UPDATE human_request_notifications SET sent=1 WHERE request_id=? AND channel=? AND destination=?",
      )
      .run(id, channel, destination);
  }

  canReply(id: string, version: number, channel: string, destination: string): boolean {
    return !!this.db
      .query(
        "SELECT 1 FROM human_request_notifications WHERE request_id=? AND version=? AND channel=? AND destination=? AND can_reply=1",
      )
      .get(id, version, channel, destination);
  }

  private expire(): void {
    this.db
      .query(
        "UPDATE human_requests SET status='unavailable',delivery_error='Command execution was interrupted or its result is unknown; inspect the host before creating another request',version=version+1 WHERE status='running' AND responded_at<?",
      )
      .run(this.now() - 330000);
    const cutoff =
      this.now() - (loadConfig().preferences.attention_retention_hours ?? 72) * 3600000;
    this.db
      .query(
        "UPDATE human_requests SET status='expired',version=version+1 WHERE status IN ('pending','answered','unavailable') AND created_at<=?",
      )
      .run(cutoff);
    this.db
      .query(
        "UPDATE human_requests SET status='expired',version=version+1 WHERE status='pending' AND expires_at<=?",
      )
      .run(this.now());
    this.db
      .query(
        "UPDATE human_requests SET status='unavailable',delivery_error='Originating runtime disconnected; response was not delivered',version=version+1 WHERE owner_id IS NOT NULL AND owner_heartbeat_at<? AND status IN ('pending','answered')",
      )
      .run(this.now() - 30000);
  }

  get(id: string): HumanRequest {
    this.expire();
    const row = this.db
      .query<
        {
          id: string;
          payload: string;
          status: string;
          version: number;
          response: string | null;
          created_at: number;
          expires_at: number;
          responded_at: number | null;
          delivered_at: number | null;
        },
        [string]
      >("SELECT * FROM human_requests WHERE id=?")
      .get(id);
    if (!row) throw new NotFoundError("Human request", id);
    return HumanRequestSchema.parse({
      ...row,
      input: JSON.parse(row.payload),
      response: row.response ? JSON.parse(row.response) : null,
    });
  }

  create(raw: unknown, ownerId?: string): HumanRequest {
    const input = HumanRequestInputSchema.parse(raw);
    const payload = JSON.stringify(input);
    if (payload.length > 64000) throw new ValidationError("Request exceeds 64000 characters");
    const originKey = JSON.stringify(input.origin);
    const hash = createHash("sha256").update(payload).digest("hex");
    return this.db
      .transaction(() => {
        const existing = this.db
          .query<{ id: string; input_hash: string; owner_id: string | null }, [string]>(
            "SELECT id,input_hash,owner_id FROM human_requests WHERE origin_key=?",
          )
          .get(originKey);
        if (existing) {
          if (existing.input_hash !== hash)
            throw new ConflictError("Origin request identity reused with different content");
          if (ownerId && existing.owner_id !== ownerId)
            throw new ConflictError("Request belongs to another runtime");
          return this.get(existing.id);
        }
        const id = ulid();
        const now = this.now();
        this.db
          .query(
            "INSERT INTO human_requests(id,origin_key,input_hash,payload,status,version,created_at,expires_at,owner_id,owner_heartbeat_at) VALUES (?,?,?,?,'pending',1,?,?,?,?)",
          )
          .run(
            id,
            originKey,
            hash,
            payload,
            now,
            now + input.expires_in_seconds * 1000,
            ownerId ?? null,
            ownerId ? now : null,
          );
        return this.get(id);
      })
      .immediate();
  }

  heartbeat(id: string, ownerId: string): void {
    this.expire();
    const result = this.db
      .query(
        "UPDATE human_requests SET owner_heartbeat_at=? WHERE id=? AND owner_id=? AND status IN ('pending','answered')",
      )
      .run(this.now(), id, ownerId);
    if (!result.changes) throw new ConflictError("Runtime no longer owns this pending request");
  }

  responseFetched(id: string, ownerId: string): void {
    // A command may run for hours after its approval is returned. Its real tool-result
    // hook acknowledges consumption; the short waiting-owner lease no longer applies.
    this.db
      .query(
        "UPDATE human_requests SET owner_heartbeat_at=NULL WHERE id=? AND owner_id=? AND status='answered'",
      )
      .run(id, ownerId);
  }

  list(): HumanRequest[] {
    this.expire();
    return this.db
      .query<{ id: string }, []>(
        "SELECT id FROM human_requests WHERE status IN ('pending','running','answered','unavailable') ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,created_at,id LIMIT 100",
      )
      .all()
      .map((row) => this.get(row.id));
  }

  respond(id: string, version: number, raw: unknown): HumanRequest {
    const response = HumanResponseSchema.parse(raw);
    if (response.kind === "command") throw new ValidationError("Use the Run action for commands");
    return this.db
      .transaction(() => {
        const request = this.get(id);
        if (request.status !== "pending" || request.version !== version)
          throw new ConflictError("Request is stale or already answered; reload it");
        if (request.input.kind !== response.kind)
          throw new ValidationError("Response kind does not match request");
        if (
          response.kind === "question" &&
          response.selected_choices &&
          (!request.input.multi_select ||
            new Set(response.selected_choices).size !== response.selected_choices.length ||
            response.selected_choices.some((choice) => !request.input.choices.includes(choice)) ||
            response.answer !== response.selected_choices.join(", "))
        )
          throw new ValidationError("Selected choices do not match this question");
        this.db
          .query(
            "UPDATE human_requests SET status='answered',response=?,responded_at=?,version=version+1 WHERE id=? AND status='pending' AND version=?",
          )
          .run(JSON.stringify(response), this.now(), id, version);
        return this.get(id);
      })
      .immediate();
  }

  claimCommand(id: string, version: number): HumanRequest {
    return this.db
      .transaction(() => {
        const request = this.get(id);
        if (request.input.kind !== "command")
          throw new ValidationError("This is not a command request");
        if (request.status !== "pending" || request.version !== version)
          throw new ConflictError("Command is stale or already started; reload it");
        this.db
          .query(
            "UPDATE human_requests SET status='running',responded_at=?,version=version+1 WHERE id=? AND status='pending' AND version=?",
          )
          .run(this.now(), id, version);
        return this.get(id);
      })
      .immediate();
  }

  completeCommand(id: string, version: number, raw: unknown): HumanRequest {
    const result = CommandResultSchema.parse(raw);
    const changed = this.db
      .query(
        "UPDATE human_requests SET status='answered',response=?,version=version+1 WHERE id=? AND status='running' AND version=?",
      )
      .run(JSON.stringify(result), id, version);
    if (!changed.changes) throw new ConflictError("Command execution no longer owns this request");
    return this.get(id);
  }

  acknowledge(id: string, version: number): HumanRequest {
    return this.db
      .transaction(() => {
        const request = this.get(id);
        if (request.status !== "answered" || request.version !== version)
          throw new ConflictError("Response is stale or already delivered");
        this.db
          .query(
            "UPDATE human_requests SET status='delivered',delivered_at=?,version=version+1 WHERE id=? AND status='answered' AND version=?",
          )
          .run(this.now(), id, version);
        return this.get(id);
      })
      .immediate();
  }

  acknowledgeToolResults(sessionId: string, backend: string, toolCallId: string): void {
    this.dismissObsolete(sessionId, backend, toolCallId);
    const rows = this.db
      .query<{ id: string }, [string, string, string]>(
        "SELECT id FROM human_requests WHERE status='answered' AND json_extract(payload,'$.origin.session_id')=? AND json_extract(payload,'$.origin.backend')=? AND json_extract(payload,'$.origin.tool_call_id')=?",
      )
      .all(sessionId, backend, toolCallId);
    for (const row of rows) {
      const request = this.get(row.id);
      if (request.status === "answered") this.acknowledge(row.id, request.version);
    }
  }

  dismissObsolete(sessionId: string, backend: string, toolCallId?: string): void {
    // Continuation is not proof that an undelivered answer was consumed. Preserve
    // the audit record as cancelled, and never turn it into an approval/delivery.
    this.db
      .query(
        `UPDATE human_requests SET status='cancelled',version=version+1
         WHERE status IN (${toolCallId === undefined ? "'pending','answered','unavailable'" : "'pending','unavailable'"})
         AND json_extract(payload,'$.origin.session_id')=?
         AND json_extract(payload,'$.origin.backend')=?
         AND json_extract(payload,'$.origin.chat_thread_id') IS NULL
         ${toolCallId === undefined ? "" : "AND json_extract(payload,'$.origin.tool_call_id')=?"}`,
      )
      .run(...(toolCallId === undefined ? [sessionId, backend] : [sessionId, backend, toolCallId]));
  }

  acknowledgeDeniedAtStop(sessionId: string, backend: string): void {
    // Claude does not emit a post-tool hook for tools blocked by PreToolUse.
    // A natural Stop confirms that session continued past its denial response.
    const rows = this.db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM human_requests WHERE status='answered' AND json_extract(payload,'$.origin.session_id')=? AND json_extract(payload,'$.origin.backend')=? AND json_extract(response,'$.kind')='approval' AND json_extract(response,'$.approved')=0",
      )
      .all(sessionId, backend);
    for (const row of rows) {
      const request = this.get(row.id);
      if (request.status === "answered") this.acknowledge(row.id, request.version);
    }
  }

  unavailable(id: string, version: number): HumanRequest {
    return this.db
      .transaction(() => {
        const request = this.get(id);
        if (!["pending", "answered"].includes(request.status) || request.version !== version)
          throw new ConflictError("Request is stale or no longer deliverable");
        this.db
          .query(
            "UPDATE human_requests SET status='unavailable',delivery_error='Originating runtime is unavailable; response was not delivered',version=version+1 WHERE id=? AND version=?",
          )
          .run(id, version);
        return this.get(id);
      })
      .immediate();
  }

  cancel(id: string, version: number): HumanRequest {
    return this.db
      .transaction(() => {
        const request = this.get(id);
        if (!["pending", "unavailable"].includes(request.status) || request.version !== version)
          throw new ConflictError("Request is stale or no longer pending");
        this.db
          .query(
            "UPDATE human_requests SET status='cancelled',version=version+1 WHERE id=? AND version=?",
          )
          .run(id, version);
        return this.get(id);
      })
      .immediate();
  }
}

export function currentHumanRequest(store: HumanRequestStore, id: string): HumanRequest {
  const request = store.get(id);
  const bindings =
    request.input.rule_bindings ?? (request.input.rule_binding ? [request.input.rule_binding] : []);
  if (!bindings.length || !["pending", "answered"].includes(request.status)) return request;
  let active = false;
  try {
    active =
      loadConfig().rules.enabled &&
      bindings.every((binding) =>
        new RuleStore(store.db)
          .active(binding.workspace)
          .some(
            (revision) =>
              revision.id === binding.revision_id &&
              revision.policy?.rules.some((rule) => rule.id === binding.rule_id && rule.enabled),
          ),
      );
  } catch {}
  if (active) return request;
  return request.status === "pending"
    ? store.cancel(id, request.version)
    : store.unavailable(id, request.version);
}
