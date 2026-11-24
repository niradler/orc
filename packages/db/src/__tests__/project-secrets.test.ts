import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConflictError, TooManyRequestsError } from "@orc/core/errors";
import { resetRedactedSecrets } from "@orc/core/secret-redactor";
import { isEncryptedSecret } from "@orc/core/secrets";
import { createDb } from "../client.js";
import { HumanRequestStore } from "../human-requests.js";
import { ProjectSecretStore } from "../project-secrets.js";
import { SecretDeliveryVault } from "../secret-vault.js";

const tempDirs: string[] = [];
const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "orc-db-secrets-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  resetRedactedSecrets();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("project_secrets migration and store", () => {
  test("migrates an existing database without project_secrets cleanly without data loss", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "legacy.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        scope TEXT,
        git_remote_url TEXT,
        tags TEXT,
        obsidian_path TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO projects(id, name) VALUES ('proj-legacy', 'legacy-app');
    `);
    legacy.close();

    const migrated = createDb(dbPath);
    const sqlite = (migrated as unknown as { $client: Database }).$client;
    try {
      const project = sqlite
        .query<{ id: string; name: string }, [string]>("SELECT id, name FROM projects WHERE id = ?")
        .get("proj-legacy");
      expect(project).toEqual({ id: "proj-legacy", name: "legacy-app" });

      const table = sqlite
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='project_secrets'",
        )
        .get();
      expect(table?.name).toBe("project_secrets");

      const store = new ProjectSecretStore(sqlite);
      const created = store.upsert("proj-legacy", {
        name: "openai-key",
        value: "sk-legacy-secret-9999",
        description: "Legacy migration test",
      });
      expect(created.created).toBe(true);
      expect(created.secret.reference).toBe("project/openai-key");
      expect(store.resolveValue("proj-legacy", "openai-key")).toBe("sk-legacy-secret-9999");
    } finally {
      sqlite.close();
    }
  });

  test("encrypts values at rest, exposes metadata only, supports rotation and deletion", () => {
    const db = createDb(":memory:");
    const sqlite = (db as unknown as { $client: Database }).$client;
    try {
      sqlite.query("INSERT INTO projects(id, name) VALUES (?, ?)").run("proj-1", "alpha");
      let now = 1_700_000_000_000;
      const store = new ProjectSecretStore(sqlite, () => now);

      const first = store.upsert("proj-1", {
        name: "api-token",
        value: "tok-initial-secret-1234",
        description: "Primary token",
      });
      expect(first.created).toBe(true);
      expect("value" in first.secret).toBe(false);
      expect("encrypted_value" in first.secret).toBe(false);
      expect(first.secret.last_used_at).toBeNull();

      const raw = sqlite
        .query<{ encrypted_value: string }, [string]>(
          "SELECT encrypted_value FROM project_secrets WHERE id = ?",
        )
        .get(first.secret.id);
      expect(raw).not.toBeNull();
      expect(isEncryptedSecret(raw?.encrypted_value ?? "")).toBe(true);
      expect(raw?.encrypted_value).not.toContain("tok-initial-secret-1234");

      now += 5000;
      expect(store.resolveValue("proj-1", "api-token")).toBe("tok-initial-secret-1234");
      expect(store.getMetadata("proj-1", "api-token").last_used_at).toBe(
        new Date(now).toISOString(),
      );

      now += 5000;
      const rotated = store.rotate("proj-1", "api-token", { value: "tok-rotated-secret-5678" });
      expect(rotated.updated_at).toBe(new Date(now).toISOString());
      expect(store.resolveValue("proj-1", "api-token")).toBe("tok-rotated-secret-5678");

      const audits = sqlite
        .query<{ snapshot: string | null }, []>("SELECT snapshot FROM audit_log")
        .all();
      const auditText = JSON.stringify(audits);
      expect(auditText).not.toContain("tok-initial-secret-1234");
      expect(auditText).not.toContain("tok-rotated-secret-5678");

      store.delete("proj-1", "api-token");
      expect(store.resolveValue("proj-1", "api-token")).toBeNull();
      expect(store.list("proj-1")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

describe("human request secret delivery vault and invariants", () => {
  test("delivers secrets once, persists zero plaintext, enforces restart unavailability, expiry, and rate limit", () => {
    const db = createDb(":memory:");
    const sqlite = (db as unknown as { $client: Database }).$client;
    try {
      sqlite.query("INSERT INTO projects(id, name) VALUES (?, ?)").run("proj-1", "alpha");
      let now = 1_700_000_000_000;
      const vault = new SecretDeliveryVault();
      const store = new HumanRequestStore(sqlite, () => now, {
        vault,
        secretPayloadTtlMs: 60_000,
        secretRateLimitMax: 3,
        secretRateLimitWindowMs: 600_000,
      });

      const created = store.create({
        origin: { session_id: "sess-a", backend: "codex", request_id: "secret-1" },
        project_id: "proj-1",
        kind: "secret",
        title: "Service credentials",
        prompt: "Enter API key and endpoint.",
        fields: [
          { key: "OPENAI_API_KEY", label: "OpenAI API key", required: true },
          { key: "BASE_URL", label: "Base URL", required: true },
        ],
      });

      const answered = store.respond(created.id, created.version, {
        kind: "secret",
        values: {
          OPENAI_API_KEY: "sk-super-secret-value-8888",
          BASE_URL: "https://private.internal.example/v1",
        },
        save_to_project: false,
      });
      expect(answered.status).toBe("answered");
      expect(answered.response).toEqual({
        kind: "secret",
        stored: false,
        delivered_fields: ["OPENAI_API_KEY", "BASE_URL"],
        consumed: false,
      });

      const tables = [
        sqlite.query("SELECT * FROM human_requests").all(),
        sqlite.query("SELECT * FROM audit_log").all(),
        sqlite.query("SELECT * FROM notifications").all(),
      ];
      const serialized = JSON.stringify(tables);
      expect(serialized).not.toContain("sk-super-secret-value-8888");
      expect(serialized).not.toContain("https://private.internal.example/v1");

      const claimed = store.claimSecret(created.id);
      expect(claimed.secret).toBe(true);
      expect(claimed.stored).toBe(false);
      expect(claimed.values).toEqual({
        OPENAI_API_KEY: "sk-super-secret-value-8888",
        BASE_URL: "https://private.internal.example/v1",
      });
      expect(() => store.claimSecret(created.id)).toThrow(ConflictError);

      // Simulate daemon restart before claim on a second secret request.
      const second = store.create({
        origin: { session_id: "sess-a", backend: "codex", request_id: "secret-2" },
        project_id: "proj-1",
        kind: "secret",
        prompt: "Second secret",
        fields: [{ key: "TOKEN", label: "Token" }],
      });
      store.respond(second.id, second.version, {
        kind: "secret",
        values: { TOKEN: "tok-lost-on-restart" },
        save_to_project: false,
      });
      const restartedStore = new HumanRequestStore(sqlite, () => now, {
        vault: new SecretDeliveryVault(),
        secretPayloadTtlMs: 60_000,
      });
      const afterRestart = restartedStore.get(second.id);
      expect(afterRestart.status).toBe("unavailable");
      expect(() => restartedStore.claimSecret(second.id)).toThrow(ConflictError);

      // Aggressive payload expiry on a third request.
      const third = store.create({
        origin: { session_id: "sess-a", backend: "codex", request_id: "secret-3" },
        project_id: "proj-1",
        kind: "secret",
        prompt: "Third secret",
        fields: [{ key: "TOKEN", label: "Token" }],
      });
      store.respond(third.id, third.version, {
        kind: "secret",
        values: { TOKEN: "tok-expires-fast" },
        save_to_project: false,
      });
      now += 61_000;
      expect(store.get(third.id).status).toBe("unavailable");

      // Rate limit kicks in on 4th request for the same session.
      expect(() =>
        store.create({
          origin: { session_id: "sess-a", backend: "codex", request_id: "secret-4" },
          project_id: "proj-1",
          kind: "secret",
          prompt: "Fourth secret",
          fields: [{ key: "TOKEN", label: "Token" }],
        }),
      ).toThrow(TooManyRequestsError);
    } finally {
      sqlite.close();
    }
  });
});
