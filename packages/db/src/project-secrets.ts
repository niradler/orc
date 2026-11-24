import type { Database } from "bun:sqlite";
import { NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import {
  formatProjectSecretRef,
  type ProjectSecretCheck,
  ProjectSecretCheckSchema,
  type ProjectSecretMetadata,
  ProjectSecretMetadataSchema,
  ProjectSecretNameSchema,
  type ProjectSecretRotate,
  ProjectSecretRotateSchema,
  type ProjectSecretUpsert,
  ProjectSecretUpsertSchema,
  parseProjectSecretRef,
  SecretRefsMapSchema,
} from "@orc/core/project-secrets";
import { registerRedactedSecrets } from "@orc/core/secret-redactor";
import { decryptSecret, encryptSecret } from "@orc/core/secrets";
import { type AuditActor, AuditLog, installAudit } from "./audit.js";

export function installProjectSecrets(sqlite: Database): void {
  installAudit(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS project_secrets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      description TEXT,
      check_config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_secrets_project_name_idx
      ON project_secrets(project_id, name);
    CREATE INDEX IF NOT EXISTS project_secrets_project_idx
      ON project_secrets(project_id);
  `);
}

type SecretMetadataRow = {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  check_config: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
};

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function rowToMetadata(row: SecretMetadataRow): ProjectSecretMetadata {
  const check = row.check_config
    ? ProjectSecretCheckSchema.parse(JSON.parse(row.check_config))
    : null;
  return ProjectSecretMetadataSchema.parse({
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    reference: formatProjectSecretRef(row.name),
    description: row.description ?? null,
    check,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    last_used_at: row.last_used_at !== null ? toIso(row.last_used_at) : null,
  });
}

export class ProjectSecretStore {
  constructor(
    readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    installProjectSecrets(db);
  }

  private assertProject(projectId: string): void {
    const exists = this.db
      .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ?")
      .get(projectId);
    if (!exists) throw new NotFoundError("Project", projectId);
  }

  list(projectId: string): ProjectSecretMetadata[] {
    this.assertProject(projectId);
    return this.db
      .query<SecretMetadataRow, [string]>(
        `SELECT id, project_id, name, description, check_config, created_at, updated_at, last_used_at
         FROM project_secrets WHERE project_id = ? ORDER BY name ASC`,
      )
      .all(projectId)
      .map(rowToMetadata);
  }

  getMetadata(projectId: string, rawName: string): ProjectSecretMetadata {
    this.assertProject(projectId);
    const name = ProjectSecretNameSchema.parse(rawName);
    const row = this.db
      .query<SecretMetadataRow, [string, string]>(
        `SELECT id, project_id, name, description, check_config, created_at, updated_at, last_used_at
         FROM project_secrets WHERE project_id = ? AND name = ?`,
      )
      .get(projectId, name);
    if (!row) throw new NotFoundError("Project secret", formatProjectSecretRef(name));
    return rowToMetadata(row);
  }

  upsert(
    projectId: string,
    raw: ProjectSecretUpsert,
    actor: AuditActor = {},
  ): { secret: ProjectSecretMetadata; created: boolean } {
    this.assertProject(projectId);
    const input = ProjectSecretUpsertSchema.parse(raw);
    const encrypted = encryptSecret(input.value);
    const now = this.now();
    const checkJson =
      input.check === undefined ? undefined : input.check ? JSON.stringify(input.check) : null;
    const description =
      input.description === undefined ? undefined : input.description?.trim() || null;

    const result = this.db
      .transaction(() => {
        const existing = this.db
          .query<SecretMetadataRow, [string, string]>(
            `SELECT id, project_id, name, description, check_config, created_at, updated_at, last_used_at
             FROM project_secrets WHERE project_id = ? AND name = ?`,
          )
          .get(projectId, input.name);

        if (existing) {
          this.db
            .query(
              `UPDATE project_secrets
               SET encrypted_value = ?, description = ?, check_config = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              encrypted,
              description === undefined ? existing.description : description,
              checkJson === undefined ? existing.check_config : checkJson,
              now,
              existing.id,
            );
          const updated = this.getMetadata(projectId, input.name);
          new AuditLog(this.db, { now: this.now }).record({
            action: "project_secret.rotated",
            project_id: projectId,
            actor: actor.actor,
            session_id: actor.session_id,
            subject_ids: [updated.id],
            snapshot: {
              name: updated.name,
              reference: updated.reference,
              has_check: updated.check !== null,
            },
          });
          return { secret: updated, created: false };
        }

        const id = ulid();
        this.db
          .query(
            `INSERT INTO project_secrets
             (id, project_id, name, encrypted_value, description, check_config, created_at, updated_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            id,
            projectId,
            input.name,
            encrypted,
            description ?? null,
            checkJson ?? null,
            now,
            now,
          );
        const created = this.getMetadata(projectId, input.name);
        new AuditLog(this.db, { now: this.now }).record({
          action: "project_secret.created",
          project_id: projectId,
          actor: actor.actor,
          session_id: actor.session_id,
          subject_ids: [created.id],
          snapshot: {
            name: created.name,
            reference: created.reference,
            has_check: created.check !== null,
          },
        });
        return { secret: created, created: true };
      })
      .immediate();

    registerRedactedSecrets([input.value]);
    return result;
  }

  rotate(
    projectId: string,
    rawName: string,
    raw: ProjectSecretRotate,
    actor: AuditActor = {},
  ): ProjectSecretMetadata {
    this.assertProject(projectId);
    const name = ProjectSecretNameSchema.parse(rawName);
    const input = ProjectSecretRotateSchema.parse(raw);
    const now = this.now();

    const updated = this.db
      .transaction(() => {
        const existing = this.db
          .query<SecretMetadataRow & { encrypted_value: string }, [string, string]>(
            `SELECT id, project_id, name, encrypted_value, description, check_config, created_at, updated_at, last_used_at
             FROM project_secrets WHERE project_id = ? AND name = ?`,
          )
          .get(projectId, name);
        if (!existing) throw new NotFoundError("Project secret", formatProjectSecretRef(name));

        const nextEncrypted =
          input.value !== undefined ? encryptSecret(input.value) : existing.encrypted_value;
        const nextDescription =
          input.description === undefined
            ? existing.description
            : input.description?.trim() || null;
        const nextCheck =
          input.check === undefined
            ? existing.check_config
            : input.check
              ? JSON.stringify(input.check)
              : null;

        this.db
          .query(
            `UPDATE project_secrets
             SET encrypted_value = ?, description = ?, check_config = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(nextEncrypted, nextDescription, nextCheck, now, existing.id);

        const metadata = this.getMetadata(projectId, name);
        new AuditLog(this.db, { now: this.now }).record({
          action: input.value !== undefined ? "project_secret.rotated" : "project_secret.updated",
          project_id: projectId,
          actor: actor.actor,
          session_id: actor.session_id,
          subject_ids: [metadata.id],
          snapshot: {
            name: metadata.name,
            reference: metadata.reference,
            has_check: metadata.check !== null,
          },
        });
        return metadata;
      })
      .immediate();

    if (input.value !== undefined) registerRedactedSecrets([input.value]);
    return updated;
  }

  delete(projectId: string, rawName: string, actor: AuditActor = {}): void {
    this.assertProject(projectId);
    const name = ProjectSecretNameSchema.parse(rawName);
    this.db
      .transaction(() => {
        const existing = this.db
          .query<{ id: string }, [string, string]>(
            "SELECT id FROM project_secrets WHERE project_id = ? AND name = ?",
          )
          .get(projectId, name);
        if (!existing) throw new NotFoundError("Project secret", formatProjectSecretRef(name));
        this.db.query("DELETE FROM project_secrets WHERE id = ?").run(existing.id);
        new AuditLog(this.db, { now: this.now }).record({
          action: "project_secret.deleted",
          project_id: projectId,
          actor: actor.actor,
          session_id: actor.session_id,
          subject_ids: [existing.id],
          snapshot: { name, reference: formatProjectSecretRef(name) },
        });
      })
      .immediate();
  }

  resolveValue(projectId: string, rawName: string): string | null {
    const parsed = ProjectSecretNameSchema.safeParse(rawName);
    if (!parsed.success) return null;
    const row = this.db
      .query<{ id: string; encrypted_value: string }, [string, string]>(
        "SELECT id, encrypted_value FROM project_secrets WHERE project_id = ? AND name = ?",
      )
      .get(projectId, parsed.data);
    if (!row) return null;
    const plain = decryptSecret(row.encrypted_value);
    this.db
      .query("UPDATE project_secrets SET last_used_at = ? WHERE id = ?")
      .run(this.now(), row.id);
    registerRedactedSecrets([plain]);
    return plain;
  }

  getCheckConfig(projectId: string, rawName: string): ProjectSecretCheck | null {
    return this.getMetadata(projectId, rawName).check;
  }

  recordCheck(
    projectId: string,
    rawName: string,
    result: { mode: "stored" | "http" | "command"; ok: boolean; status: number | null },
    actor: AuditActor = {},
  ): void {
    const metadata = this.getMetadata(projectId, rawName);
    new AuditLog(this.db, { now: this.now }).record({
      action: "project_secret.checked",
      project_id: projectId,
      actor: actor.actor,
      session_id: actor.session_id,
      subject_ids: [metadata.id],
      snapshot: {
        name: metadata.name,
        reference: metadata.reference,
        mode: result.mode,
        ok: result.ok,
        status: result.status,
      },
    });
  }

  loadAllForRedaction(): number {
    const rows = this.db
      .query<{ encrypted_value: string }, []>("SELECT encrypted_value FROM project_secrets")
      .all();
    const values: string[] = [];
    for (const row of rows) {
      try {
        values.push(decryptSecret(row.encrypted_value));
      } catch {}
    }
    registerRedactedSecrets(values);
    return values.length;
  }
}

export function deleteProjectSecrets(sqlite: Database, projectId: string): void {
  installProjectSecrets(sqlite);
  sqlite.query("DELETE FROM project_secrets WHERE project_id = ?").run(projectId);
}

export function resolveProjectSecretEnv(
  sqlite: Database,
  projectId: string | null | undefined,
  env: Record<string, string>,
): { env: Record<string, string>; secrets: string[] } {
  const out: Record<string, string> = {};
  const secrets: string[] = [];
  let store: ProjectSecretStore | null = null;
  for (const [key, value] of Object.entries(env)) {
    const secretName = parseProjectSecretRef(value);
    if (!secretName) {
      out[key] = value;
      continue;
    }
    if (!projectId) {
      throw new ValidationError(
        `Secret reference "${value}" requires a project on this job or launch`,
      );
    }
    store ??= new ProjectSecretStore(sqlite);
    const resolved = store.resolveValue(projectId, secretName);
    if (resolved === null) {
      throw new ValidationError(`Project secret "${value}" was not found`);
    }
    out[key] = resolved;
    secrets.push(resolved);
  }
  return { env: out, secrets };
}

export function resolveExplicitSecretRefs(
  sqlite: Database,
  projectId: string | null | undefined,
  rawRefs: Record<string, string> | undefined,
): { env: Record<string, string>; secrets: string[] } {
  if (!rawRefs || !Object.keys(rawRefs).length) return { env: {}, secrets: [] };
  const refs = SecretRefsMapSchema.parse(rawRefs);
  return resolveProjectSecretEnv(sqlite, projectId, refs);
}
