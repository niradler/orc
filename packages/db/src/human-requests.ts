import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { loadConfig } from "@orc/core/config";
import {
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
  ValidationError,
} from "@orc/core/errors";
import {
  CommandResultSchema,
  type HumanRequest,
  type HumanRequestInput,
  HumanRequestInputSchema,
  HumanRequestSchema,
  HumanRespondPayloadSchema,
  MAX_SNOOZE_SECONDS,
  type SecretClaimResult,
  type SecretResponse,
} from "@orc/core/human-requests";
import { ulid } from "@orc/core/ids";
import { defaultProjectSecretName, formatProjectSecretRef } from "@orc/core/project-secrets";
import { registerRedactedSecrets } from "@orc/core/secret-redactor";
import { type AuditActor, AuditLog, installAudit } from "./audit.js";
import { publishNotification } from "./notification-producers.js";
import { NotificationStore, tableExists } from "./notifications.js";
import { ProjectSecretStore } from "./project-secrets.js";
import { RuleStore } from "./rules.js";
import { defaultSecretVault, type SecretDeliveryVault } from "./secret-vault.js";

/** A request in one of these states will never become pending again. */
const TERMINAL_STATUSES = ["answered", "delivered", "cancelled", "expired", "unavailable"] as const;
const TERMINAL_SQL = `(${TERMINAL_STATUSES.map((status) => `'${status}'`).join(",")})`;

export const SECRET_REQUEST_MAX_TTL_SECONDS = 1800;
export const SECRET_PAYLOAD_TTL_MS = 5 * 60 * 1000;
export const SECRET_RATE_LIMIT_MAX = 10;
export const SECRET_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export type HumanRequestStoreOptions = {
  vault?: SecretDeliveryVault;
  secretPayloadTtlMs?: number;
  secretRateLimitMax?: number;
  secretRateLimitWindowMs?: number;
};

/**
 * The folder a request came from, for a label when no project owns it. Only
 * server-known folders count: agent-supplied paths must never become titles.
 */
export function humanRequestFolder(db: Database, input: HumanRequestInput): string | null {
  const threadId = input.origin.chat_thread_id;
  if (threadId && tableExists(db, "chat_threads")) {
    const cwd = db
      .query<{ cwd: string | null }, [string]>(
        "SELECT CASE WHEN json_valid(data) THEN json_extract(data,'$.cwd') END AS cwd FROM chat_threads WHERE id=?",
      )
      .get(threadId)?.cwd;
    if (cwd) return cwd;
  }
  if (!tableExists(db, "gateway_sessions")) return null;
  for (const id of [input.origin.session_id, input.origin.native_session_id]) {
    if (!id) continue;
    const cwd = db
      .query<{ cwd: string | null }, [string, string]>(
        "SELECT cwd FROM gateway_sessions WHERE cwd IS NOT NULL AND (id=? OR runtime_session_id=?) LIMIT 1",
      )
      .get(id, id)?.cwd;
    if (cwd) return cwd;
  }
  return null;
}

export class HumanRequestStore {
  private readonly vault: SecretDeliveryVault;
  private readonly secretPayloadTtlMs: number;
  private readonly secretRateLimitMax: number;
  private readonly secretRateLimitWindowMs: number;

  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
    options: HumanRequestStoreOptions = {},
  ) {
    this.vault = options.vault ?? defaultSecretVault;
    this.secretPayloadTtlMs = options.secretPayloadTtlMs ?? SECRET_PAYLOAD_TTL_MS;
    this.secretRateLimitMax = options.secretRateLimitMax ?? SECRET_RATE_LIMIT_MAX;
    this.secretRateLimitWindowMs = options.secretRateLimitWindowMs ?? SECRET_RATE_LIMIT_WINDOW_MS;
    installAudit(db);
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
      ["answered_at", "INTEGER"],
      ["seen_at", "INTEGER"],
      ["snooze_until", "INTEGER"],
      ["push_state", "TEXT"],
      ["push_error", "TEXT"],
    ])
      if (!columns.some((column) => column.name === name))
        db.exec(`ALTER TABLE human_requests ADD COLUMN ${name} ${type}`);
    db.exec(
      "CREATE INDEX IF NOT EXISTS human_requests_snooze ON human_requests(status,snooze_until) WHERE snooze_until IS NOT NULL;",
    );
    db.exec(`CREATE TABLE IF NOT EXISTS human_request_notifications (
      request_id TEXT NOT NULL, channel TEXT NOT NULL, destination TEXT NOT NULL,
      version INTEGER NOT NULL, can_reply INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
      leased_until INTEGER NOT NULL, PRIMARY KEY(request_id,channel,destination)
    )`);
  }

  private publishRequestNotification(
    id: string,
    input: HumanRequestInput,
    createdAt: number,
  ): void {
    publishNotification(
      this.db,
      {
        type: "human.request",
        source_key: `human:${id}`,
        source_id: id,
        title:
          input.title ??
          `${input.kind === "approval" ? "Approval" : input.kind === "command" ? "Command" : input.kind === "secret" ? "Secret" : "Question"} · ${input.origin.backend}`,
        body: input.origin.session_title ?? "An agent needs your response.",
        level: "needs-you",
        project_id: input.project_id,
        cwd: humanRequestFolder(this.db, input),
        path: `/activity?notifications=open&request=${encodeURIComponent(id)}`,
        requires_action: true,
        created_at: createdAt,
      },
      this.now,
    );
  }

  currentTime(): number {
    return this.now();
  }

  isSnoozed(request: Pick<HumanRequest, "status" | "snooze_until">, at = this.now()): boolean {
    return (
      request.status === "pending" && request.snooze_until !== null && request.snooze_until > at
    );
  }

  private recordStatus(
    row: { id: string; status: string; version: number; payload: string },
    created = false,
  ): void {
    const input = HumanRequestInputSchema.parse(JSON.parse(row.payload));
    new AuditLog(this.db, { now: this.now }).record({
      action: created ? "human_request.created" : `human_request.${row.status}`,
      subject_ids: [row.id],
      project_id: input.project_id,
      session_id: input.origin.session_id,
      snapshot: {
        kind: input.kind,
        status: row.status,
        version: row.version,
        backend: input.origin.backend,
      },
    });
  }

  private updateStatus(sql: string, ...params: (string | number | null)[]): { changes: number } {
    return this.db
      .transaction(() => {
        const rows = this.db
          .query<
            { id: string; status: string; version: number; payload: string },
            (string | number | null)[]
          >(`${sql} RETURNING id,status,version,payload`)
          .all(...params);
        for (const row of rows) {
          if (["cancelled", "expired", "unavailable", "delivered"].includes(row.status)) {
            this.vault.delete(row.id);
          }
          this.recordStatus(row);
        }
        return { changes: rows.length };
      })
      .immediate();
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

  private expire(at = this.now()): void {
    this.vault.prune(at);
    this.updateStatus(
      "UPDATE human_requests SET status='unavailable',snooze_until=NULL,delivery_error='Command execution was interrupted or its result is unknown; inspect the host before creating another request',version=version+1 WHERE status='running' AND responded_at<?",
      at - 330000,
    );
    const cutoff = at - (loadConfig().preferences.attention_retention_hours ?? 72) * 3600000;
    const expiredRetention = this.db
      .query<{ id: string }, [number]>(
        "SELECT id FROM human_requests WHERE status IN ('pending','answered','unavailable') AND created_at<=?",
      )
      .all(cutoff);
    this.updateStatus(
      "UPDATE human_requests SET status='expired',snooze_until=NULL,version=version+1 WHERE status IN ('pending','answered','unavailable') AND created_at<=?",
      cutoff,
    );
    for (const row of expiredRetention) this.vault.delete(row.id);

    const expiredPending = this.db
      .query<{ id: string }, [number]>(
        "SELECT id FROM human_requests WHERE status='pending' AND expires_at<=?",
      )
      .all(at);
    this.updateStatus(
      "UPDATE human_requests SET status='expired',snooze_until=NULL,version=version+1 WHERE status='pending' AND expires_at<=?",
      at,
    );
    for (const row of expiredPending) this.vault.delete(row.id);

    const lostOwners = this.db
      .query<{ id: string }, [number]>(
        "SELECT id FROM human_requests WHERE owner_id IS NOT NULL AND owner_heartbeat_at<? AND status IN ('pending','answered')",
      )
      .all(at - 30000);
    this.updateStatus(
      "UPDATE human_requests SET status='unavailable',snooze_until=NULL,delivery_error='Originating runtime disconnected; response was not delivered',version=version+1 WHERE owner_id IS NOT NULL AND owner_heartbeat_at<? AND status IN ('pending','answered')",
      at - 30000,
    );
    for (const row of lostOwners) this.vault.delete(row.id);

    // Ephemeral secret payloads live only in memory; expiry or restart makes them unrecoverable.
    const unclaimedSecrets = this.db
      .query<{ id: string }, []>(
        `SELECT id FROM human_requests
         WHERE status='answered'
           AND json_extract(payload,'$.kind')='secret'
           AND IFNULL(json_extract(response,'$.stored'),0)=0
           AND IFNULL(json_extract(response,'$.consumed'),0)=0`,
      )
      .all();
    for (const row of unclaimedSecrets) {
      if (!this.vault.has(row.id, at)) {
        this.updateStatus(
          "UPDATE human_requests SET status='unavailable',snooze_until=NULL,delivery_error='Secret payload expired or daemon restarted before delivery; values are no longer recoverable',version=version+1 WHERE id=? AND status='answered'",
          row.id,
        );
      }
    }
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
          snooze_until: number | null;
        },
        [string]
      >("SELECT * FROM human_requests WHERE id=?")
      .get(id);
    if (!row) throw new NotFoundError("Human request", id);
    const request = HumanRequestSchema.parse({
      ...row,
      input: JSON.parse(row.payload),
      response: row.response ? JSON.parse(row.response) : null,
    });
    if (request.status === "pending" || request.status === "unavailable") {
      this.publishRequestNotification(request.id, request.input, request.created_at);
    } else new NotificationStore(this.db, this.now).resolve(`human:${request.id}`);
    return request;
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
        if (input.kind === "secret") {
          const recent =
            this.db
              .query<{ count: number }, [string, number]>(
                `SELECT count(*) AS count FROM human_requests
                 WHERE json_extract(payload,'$.kind')='secret'
                   AND json_extract(payload,'$.origin.session_id')=?
                   AND created_at>=?`,
              )
              .get(input.origin.session_id, now - this.secretRateLimitWindowMs)?.count ?? 0;
          if (recent >= this.secretRateLimitMax) {
            throw new TooManyRequestsError(
              "Too many secret requests for this session; wait before requesting another secret",
              {
                limit: this.secretRateLimitMax,
                window_ms: this.secretRateLimitWindowMs,
              },
            );
          }
        }
        const ttlSeconds =
          input.kind === "secret"
            ? Math.min(input.expires_in_seconds, SECRET_REQUEST_MAX_TTL_SECONDS)
            : input.expires_in_seconds;
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
            now + ttlSeconds * 1000,
            ownerId ?? null,
            ownerId ? now : null,
          );
        this.recordStatus({ id, status: "pending", version: 1, payload }, true);
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
    // A returned command can run for hours; its tool-result hook acknowledges it, not the owner lease.
    this.db
      .query(
        "UPDATE human_requests SET owner_heartbeat_at=NULL WHERE id=? AND owner_id=? AND status='answered'",
      )
      .run(id, ownerId);
  }

  seen(id: string): boolean {
    return (
      this.db
        .query(
          "UPDATE human_requests SET seen_at=? WHERE id=? AND status='answered' AND seen_at IS NULL",
        )
        .run(this.now(), id).changes > 0
    );
  }

  // Runtime-owned, native tool-call, and unstored secret requests have their own delivery paths.
  private static readonly PUSHABLE = `status='answered' AND owner_id IS NULL AND seen_at IS NULL
    AND push_state IS NULL AND answered_at IS NOT NULL
    AND IFNULL(json_extract(payload,'$.deliver_to_session'),1)=1
    AND json_extract(payload,'$.origin.tool_call_id') IS NULL
    AND NOT (json_extract(payload,'$.kind')='secret' AND IFNULL(json_extract(response,'$.stored'),0)=0)`;

  // Newest first so stuck answers never crowd out new ones.
  pushCandidates(graceMs: number): HumanRequest[] {
    this.expire();
    return this.db
      .query<{ id: string }, [number]>(
        `SELECT id FROM human_requests WHERE ${HumanRequestStore.PUSHABLE} AND answered_at<=?
         ORDER BY answered_at DESC LIMIT 100`,
      )
      .all(this.now() - graceMs)
      .map((row) => this.get(row.id));
  }

  nextPushAt(graceMs: number): number | null {
    const row = this.db
      .query<{ due: number | null }, [number, number, number]>(
        `SELECT min(answered_at + ?) AS due FROM human_requests
         WHERE ${HumanRequestStore.PUSHABLE} AND answered_at + ? > ?`,
      )
      .get(graceMs, graceMs, this.now());
    return row?.due ?? null;
  }

  claimPush(ids: string[]): HumanRequest[] {
    return this.db
      .transaction(() =>
        ids.flatMap((id) =>
          this.db
            .query(
              `UPDATE human_requests SET push_state='pushing',push_error=NULL
               WHERE id=? AND ${HumanRequestStore.PUSHABLE}`,
            )
            .run(id).changes
            ? [this.get(id)]
            : [],
        ),
      )
      .immediate();
  }

  pushed(id: string): void {
    this.db
      .transaction(() => {
        this.updateStatus(
          "UPDATE human_requests SET status='delivered',delivered_at=?,push_state='pushed',version=version+1 WHERE id=? AND push_state='pushing' AND status='answered'",
          this.now(),
          id,
        );
        this.db
          .query(
            "UPDATE human_requests SET push_state='pushed',version=version+1 WHERE id=? AND push_state='pushing'",
          )
          .run(id);
      })
      .immediate();
  }

  // The answer stays answered so the agent can still read it.
  releasePush(id: string): void {
    this.db
      .query("UPDATE human_requests SET push_state=NULL WHERE id=? AND push_state='pushing'")
      .run(id);
  }

  pushFailed(id: string, error: string): void {
    this.db
      .query(
        "UPDATE human_requests SET push_state='failed',push_error=? WHERE id=? AND push_state='pushing'",
      )
      .run(error.slice(0, 1000), id);
  }

  interruptedPushes(): number {
    return this.db
      .query(
        "UPDATE human_requests SET push_state='interrupted',push_error='ORC restarted mid-push; the agent may already have this answer.' WHERE push_state='pushing'",
      )
      .run().changes;
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

  respond(id: string, version: number, raw: unknown, actor: AuditActor = {}): HumanRequest {
    const response = HumanRespondPayloadSchema.parse(raw);
    let storedInVault = false;
    try {
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

          let storedResponse: unknown = response;
          if (response.kind === "secret") {
            const fields = request.input.fields ?? [];
            const fieldMap = new Map(fields.map((field) => [field.key, field]));
            for (const key of Object.keys(response.values)) {
              if (!fieldMap.has(key)) {
                throw new ValidationError(`Unknown secret field "${key}"`);
              }
            }
            if (response.reference_names) {
              for (const key of Object.keys(response.reference_names)) {
                if (!fieldMap.has(key)) {
                  throw new ValidationError(`Unknown secret reference field "${key}"`);
                }
              }
            }
            const cleanValues: Record<string, string> = {};
            for (const field of fields) {
              const rawValue = response.values[field.key] ?? "";
              if (field.required && rawValue.length === 0) {
                throw new ValidationError(`Missing required secret field "${field.label}"`);
              }
              if (rawValue.length > 0) cleanValues[field.key] = rawValue;
            }
            const deliveredFields = Object.keys(cleanValues);
            if (!deliveredFields.length) {
              throw new ValidationError("Enter at least one secret value");
            }
            registerRedactedSecrets(Object.values(cleanValues));

            const now = this.now();
            if (response.save_to_project) {
              if (!request.input.project_id) {
                throw new ValidationError("Saving to project secrets requires a project");
              }
              const projectSecrets = new ProjectSecretStore(this.db, this.now);
              const references: Record<string, string> = {};
              const usedNames = new Set<string>();
              for (const key of deliveredFields) {
                const field = fieldMap.get(key);
                const secretName =
                  response.reference_names?.[key] ??
                  field?.reference_name ??
                  defaultProjectSecretName(key);
                if (usedNames.has(secretName)) {
                  throw new ValidationError(
                    `Duplicate project secret name "${secretName}" in secret response`,
                  );
                }
                usedNames.add(secretName);
                projectSecrets.upsert(
                  request.input.project_id,
                  {
                    name: secretName,
                    value: cleanValues[key] ?? "",
                    description: field?.description ?? field?.label ?? null,
                  },
                  { actor: actor.actor, session_id: request.input.origin.session_id },
                );
                references[key] = formatProjectSecretRef(secretName);
              }
              const secretMeta: SecretResponse = {
                kind: "secret",
                stored: true,
                references,
                delivered_fields: deliveredFields,
                consumed: false,
              };
              storedResponse = secretMeta;
            } else {
              this.vault.store(id, cleanValues, now + this.secretPayloadTtlMs);
              storedInVault = true;
              const secretMeta: SecretResponse = {
                kind: "secret",
                stored: false,
                delivered_fields: deliveredFields,
                consumed: false,
              };
              storedResponse = secretMeta;
            }
          }

          this.updateStatus(
            "UPDATE human_requests SET status='answered',snooze_until=NULL,response=?,responded_at=?,answered_at=?,version=version+1 WHERE id=? AND status='pending' AND version=?",
            JSON.stringify(storedResponse),
            this.now(),
            this.now(),
            id,
            version,
          );
          return this.get(id);
        })
        .immediate();
    } catch (error) {
      if (storedInVault) this.vault.delete(id);
      throw error;
    }
  }

  claimSecret(id: string): SecretClaimResult {
    this.expire();
    return this.db
      .transaction(() => {
        const request = this.get(id);
        if (request.input.kind !== "secret") {
          throw new ValidationError("This is not a secret request");
        }
        if (
          request.status === "delivered" ||
          (request.response?.kind === "secret" && request.response.consumed)
        ) {
          throw new ConflictError("Secret response was already consumed", "CONFLICT", {
            consumed: true,
          });
        }
        if (request.status !== "answered" || request.response?.kind !== "secret") {
          throw new ConflictError(
            `Secret request is ${request.status} and cannot be claimed`,
            "CONFLICT",
            { consumed: false, status: request.status },
          );
        }
        const now = this.now();
        const meta = request.response;
        const nextMeta: SecretResponse = { ...meta, consumed: true };

        if (meta.stored) {
          this.db
            .query(
              "UPDATE human_requests SET response=?,seen_at=COALESCE(seen_at,?) WHERE id=? AND status='answered'",
            )
            .run(JSON.stringify(nextMeta), now, id);
          const updated = this.get(id);
          return {
            request: updated,
            secret: true as const,
            consumed: false,
            stored: true,
            ...(meta.references ? { references: meta.references } : {}),
          };
        }

        const values = this.vault.claim(id, now);
        if (!values) {
          this.updateStatus(
            "UPDATE human_requests SET status='unavailable',snooze_until=NULL,delivery_error='Secret payload expired or daemon restarted before delivery; values are no longer recoverable',version=version+1 WHERE id=? AND status='answered'",
            id,
          );
          throw new ConflictError("Secret payload expired or is no longer available", "CONFLICT", {
            consumed: false,
            status: "unavailable",
          });
        }

        registerRedactedSecrets(Object.values(values));
        this.db
          .query(
            "UPDATE human_requests SET response=?,seen_at=COALESCE(seen_at,?) WHERE id=? AND status='answered'",
          )
          .run(JSON.stringify(nextMeta), now, id);
        const updated = this.get(id);
        return {
          request: updated,
          secret: true as const,
          consumed: false,
          stored: false,
          values,
        };
      })
      .immediate();
  }

  snooze(id: string, version: number, snoozeUntil: number): HumanRequest {
    const now = this.now();
    if (!Number.isSafeInteger(snoozeUntil) || snoozeUntil <= now)
      throw new ValidationError("Snooze time must be in the future");
    if (snoozeUntil > now + MAX_SNOOZE_SECONDS * 1000)
      throw new ValidationError("Snooze time cannot be more than 365 days in the future");
    return this.db
      .transaction(() => {
        const request = this.get(id);
        if (request.status !== "pending")
          throw new ConflictError(
            `Only pending requests can be snoozed (request is ${request.status})`,
          );
        if (request.version !== version) throw new ConflictError("Request is stale; reload it");
        this.db
          .query(
            "UPDATE human_requests SET snooze_until=? WHERE id=? AND status='pending' AND version=?",
          )
          .run(snoozeUntil, id, version);
        new AuditLog(this.db, { now: this.now }).record({
          action: "human_request.snoozed",
          subject_ids: [id],
          project_id: request.input.project_id,
          session_id: request.input.origin.session_id,
          snapshot: {
            kind: request.input.kind,
            status: request.status,
            version: request.version,
            backend: request.input.origin.backend,
            snooze_until: snoozeUntil,
          },
        });
        return this.get(id);
      })
      .immediate();
  }

  unsnooze(id: string, version?: number): HumanRequest {
    return this.db
      .transaction(() => {
        const request = this.get(id);
        if (request.status !== "pending")
          throw new ConflictError(
            `Only pending requests can be unsnoozed (request is ${request.status})`,
          );
        if (version !== undefined && request.version !== version)
          throw new ConflictError("Request is stale; reload it");
        if (request.snooze_until !== null) {
          this.db
            .query("UPDATE human_requests SET snooze_until=NULL WHERE id=? AND status='pending'")
            .run(id);
          new AuditLog(this.db, { now: this.now }).record({
            action: "human_request.unsnoozed",
            subject_ids: [id],
            project_id: request.input.project_id,
            session_id: request.input.origin.session_id,
            snapshot: {
              kind: request.input.kind,
              status: request.status,
              version: request.version,
              backend: request.input.origin.backend,
            },
          });
          if (tableExists(this.db, "notifications")) {
            this.db
              .query(
                "UPDATE notifications SET read_at=NULL,dismissed_at=NULL,requires_action=1 WHERE source_key=?",
              )
              .run(`human:${id}`);
          }
        }
        return this.get(id);
      })
      .immediate();
  }

  nextSnoozeAt(): number | null {
    const row = this.db
      .query<{ due: number | null }, []>(
        "SELECT min(snooze_until) AS due FROM human_requests WHERE status='pending' AND snooze_until IS NOT NULL",
      )
      .get();
    return row?.due ?? null;
  }

  wakeDueSnoozes(at: number = this.now()): HumanRequest[] {
    this.expire(at);
    const wokenIds = this.db
      .transaction(() => {
        const due = this.db
          .query<{ id: string; snooze_until: number; version: number; payload: string }, [number]>(
            "SELECT id,snooze_until,version,payload FROM human_requests WHERE status='pending' AND snooze_until IS NOT NULL AND snooze_until<=? ORDER BY snooze_until,id",
          )
          .all(at);
        if (!due.length) return [];
        this.db
          .query(
            "UPDATE human_requests SET snooze_until=NULL WHERE status='pending' AND snooze_until IS NOT NULL AND snooze_until<=?",
          )
          .run(at);
        const audit = new AuditLog(this.db, { now: () => at });
        const hasNotifications = tableExists(this.db, "notifications");
        for (const row of due) {
          const input = HumanRequestInputSchema.parse(JSON.parse(row.payload));
          audit.record({
            action: "human_request.snooze_ended",
            subject_ids: [row.id],
            project_id: input.project_id,
            session_id: input.origin.session_id,
            snapshot: {
              kind: input.kind,
              status: "pending",
              version: row.version,
              backend: input.origin.backend,
              snooze_until: row.snooze_until,
            },
          });
          this.db
            .query(
              "DELETE FROM human_request_notifications WHERE request_id=? AND channel='webpush'",
            )
            .run(row.id);
          if (hasNotifications) {
            this.db.query("DELETE FROM notifications WHERE source_key=?").run(`human:${row.id}`);
          }
          this.publishRequestNotification(row.id, input, at);
        }
        return due.map((row) => row.id);
      })
      .immediate();
    return wokenIds.map((id) => this.get(id));
  }

  claimCommand(id: string, version: number): HumanRequest {
    return this.db
      .transaction(() => {
        const request = this.get(id);
        if (request.input.kind !== "command")
          throw new ValidationError("This is not a command request");
        if (request.status !== "pending" || request.version !== version)
          throw new ConflictError("Command is stale or already started; reload it");
        this.updateStatus(
          "UPDATE human_requests SET status='running',snooze_until=NULL,responded_at=?,version=version+1 WHERE id=? AND status='pending' AND version=?",
          this.now(),
          id,
          version,
        );
        return this.get(id);
      })
      .immediate();
  }

  completeCommand(id: string, version: number, raw: unknown): HumanRequest {
    const result = CommandResultSchema.parse(raw);
    const changed = this.updateStatus(
      "UPDATE human_requests SET status='answered',snooze_until=NULL,response=?,answered_at=?,version=version+1 WHERE id=? AND status='running' AND version=?",
      JSON.stringify(result),
      this.now(),
      id,
      version,
    );
    if (!changed.changes) throw new ConflictError("Command execution no longer owns this request");
    return this.get(id);
  }

  acknowledge(id: string, version: number): HumanRequest {
    return this.db
      .transaction(() => {
        const request = this.get(id);
        if (request.status !== "answered" || request.version !== version)
          throw new ConflictError("Response is stale or already delivered");
        this.vault.delete(id);
        this.updateStatus(
          "UPDATE human_requests SET status='delivered',snooze_until=NULL,delivered_at=?,version=version+1 WHERE id=? AND status='answered' AND version=?",
          this.now(),
          id,
          version,
        );
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
    this.updateStatus(
      `UPDATE human_requests SET status='cancelled',snooze_until=NULL,version=version+1
         WHERE status IN (${toolCallId === undefined ? "'pending','answered','unavailable'" : "'pending','unavailable'"})
         AND json_extract(payload,'$.origin.session_id')=?
         AND json_extract(payload,'$.origin.backend')=?
         AND json_extract(payload,'$.origin.chat_thread_id') IS NULL
         AND push_state IS NOT 'pushing' AND push_state IS NOT 'interrupted'
         AND NOT (status='answered' AND seen_at IS NOT NULL)
         ${toolCallId === undefined ? "" : "AND json_extract(payload,'$.origin.tool_call_id')=?"}`,
      ...(toolCallId === undefined ? [sessionId, backend] : [sessionId, backend, toolCallId]),
    );
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

  unavailable(
    id: string,
    version: number,
    deliveryError = "Originating runtime is unavailable; response was not delivered",
  ): HumanRequest {
    return this.db
      .transaction(() => {
        const request = this.get(id);
        if (!["pending", "answered"].includes(request.status) || request.version !== version)
          throw new ConflictError("Request is stale or no longer deliverable");
        this.vault.delete(id);
        this.updateStatus(
          "UPDATE human_requests SET status='unavailable',snooze_until=NULL,delivery_error=?,version=version+1 WHERE id=? AND version=?",
          deliveryError,
          id,
          version,
        );
        return this.get(id);
      })
      .immediate();
  }

  /**
   * Removes terminal requests older than the retention window. Pending,
   * running and snoozed requests are never touched; a request's notification
   * rows go with it so no stale "needs you" item outlives the request.
   */
  pruneTerminal(retentionDays: number, at = this.now()): number {
    if (!Number.isFinite(retentionDays) || retentionDays < 0)
      throw new ValidationError("Retention must be a non-negative number of days");
    const cutoff = at - retentionDays * 86_400_000;
    const due = `SELECT id FROM human_requests WHERE status IN ${TERMINAL_SQL} AND COALESCE(responded_at, answered_at, created_at) < ?`;
    return this.db
      .transaction(() => {
        this.db
          .query(`DELETE FROM human_request_notifications WHERE request_id IN (${due})`)
          .run(cutoff);
        if (tableExists(this.db, "notifications")) {
          this.db
            .query(`DELETE FROM notifications WHERE type='human.request' AND source_id IN (${due})`)
            .run(cutoff);
        }
        return this.db
          .query(
            `DELETE FROM human_requests WHERE status IN ${TERMINAL_SQL} AND COALESCE(responded_at, answered_at, created_at) < ?`,
          )
          .run(cutoff).changes;
      })
      .immediate();
  }

  cancel(id: string, version: number): HumanRequest {
    return this.db
      .transaction(() => {
        const request = this.get(id);
        // A dismissed undelivered answer reads as a cancellation, which never authorizes anything.
        if (
          !["pending", "answered", "unavailable"].includes(request.status) ||
          request.version !== version
        )
          throw new ConflictError("Request is stale or no longer pending");
        const reached =
          request.seen_at !== null ||
          (request.push_state !== null && request.push_state !== "failed");
        if (request.status === "answered" && reached)
          throw new ConflictError(
            "The agent may already have this answer; it can no longer be dismissed",
          );
        this.vault.delete(id);
        this.updateStatus(
          "UPDATE human_requests SET status='cancelled',snooze_until=NULL,version=version+1 WHERE id=? AND version=?",
          id,
          version,
        );
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
