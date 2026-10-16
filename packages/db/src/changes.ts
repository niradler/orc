import type { Database } from "bun:sqlite";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { type ChangeResource, changes } from "@orc/core/changes";
import { createLogger } from "@orc/core/logger";

const logger = createLogger("db:changes");
const TABLE_RESOURCES: Record<string, ChangeResource> = {
  tasks: "tasks",
  comments: "tasks",
  task_links: "tasks",
  flow_runs: "tasks",
  flow_node_runs: "tasks",
  projects: "projects",
  memories: "memories",
  jobs: "jobs",
  job_runs: "jobs",
  job_run_logs: "jobs",
  sessions: "sessions",
  gateway_sessions: "sessions",
  session_handoffs: "sessions",
  bridge_chats: "sessions",
  bridge_messages: "sessions",
  bridge_permissions: "sessions",
  wiki_pages: "wiki",
  wiki_revisions: "wiki",
  audit_log: "audit",
  skill_changes: "skills",
  skill_usage: "skill-usage",
  skill_instructions: "skills",
  knowledge_collections: "knowledge",
  rule_heads: "rules",
  rule_revisions: "rules",
  rule_decisions: "rules",
  rule_actions: "rules",
};
const observers = new WeakMap<Database, () => void>();

export function installChangeTracking(sqlite: Database, path: string): void {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS orc_change_versions (resource TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0)",
  );
  const tables = new Set(
    sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const revisions = new Map<string, number>();
  const readChanges = (): void => {
    timer = undefined;
    if (stopped) return;
    if (sqlite.inTransaction) return;
    const dirty: ChangeResource[] = [];
    for (const row of sqlite
      .query<{ resource: ChangeResource; revision: number }, []>(
        "SELECT resource, revision FROM orc_change_versions",
      )
      .all()) {
      if (revisions.has(row.resource) && revisions.get(row.resource) !== row.revision)
        dirty.push(row.resource);
      revisions.set(row.resource, row.revision);
    }
    changes.publish(...dirty);
  };
  const schedule = (): void => {
    if (!stopped && !timer) {
      timer = setTimeout(readChanges, 25);
      timer.unref();
    }
  };
  for (const [table, resource] of Object.entries(TABLE_RESOURCES)) {
    if (!tables.has(table)) continue;
    sqlite.query("INSERT OR IGNORE INTO orc_change_versions(resource) VALUES (?)").run(resource);
    const columns = sqlite
      .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
      .all()
      .map((column) => column.name)
      .filter(
        (name) => !["updated_at", "accessed_at", "access_count", "last_accessed_at"].includes(name),
      );
    const changed = columns.map((name) => `OLD."${name}" IS NOT NEW."${name}"`).join(" OR ");
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const guard = operation === "UPDATE" ? `WHEN ${changed}` : "";
      sqlite.exec(
        `CREATE TRIGGER IF NOT EXISTS orc_change_${table}_${operation} AFTER ${operation} ON "${table}" ${guard} BEGIN UPDATE orc_change_versions SET revision=revision+1 WHERE resource='${resource}'; END`,
      );
    }
  }
  readChanges();
  const wrapped = new WeakSet<object>();
  for (const method of ["prepare", "query"] as const) {
    const original = sqlite[method].bind(sqlite);
    sqlite[method] = ((...args: Parameters<typeof original>) => {
      const statement: ReturnType<typeof sqlite.prepare> = Reflect.apply(original, sqlite, args);
      if (!/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(args[0]) || wrapped.has(statement))
        return statement;
      wrapped.add(statement);
      for (const execute of ["run", "get", "all", "values"] as const) {
        const run = statement[execute].bind(statement);
        Object.defineProperty(statement, execute, {
          configurable: true,
          value: (...bindings: unknown[]) => {
            try {
              return Reflect.apply(run, statement, bindings);
            } finally {
              schedule();
            }
          },
        });
      }
      return statement;
    }) as (typeof sqlite)[typeof method];
  }
  for (const method of ["exec", "run"] as const) {
    const original = sqlite[method].bind(sqlite);
    sqlite[method] = ((...args: Parameters<typeof original>) => {
      try {
        return Reflect.apply(original, sqlite, args);
      } finally {
        if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|COMMIT|ROLLBACK)\b/i.test(args[0])) schedule();
      }
    }) as (typeof sqlite)[typeof method];
  }
  const close = sqlite.close.bind(sqlite);
  sqlite.close = (...args: Parameters<typeof close>) => {
    stopChangeTracking(sqlite);
    return close(...args);
  };
  let watcher: ReturnType<typeof watch> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  if (path !== ":memory:") {
    const name = basename(path);
    const attach = (): void => {
      if (stopped) return;
      watcher?.close();
      const recover = (error: Error): void => {
        logger.error("Database change watcher failed", error);
        watcher?.close();
        clearTimeout(retry);
        if (!stopped) {
          retry = setTimeout(attach, 1000);
          retry.unref();
        }
      };
      try {
        watcher = watch(dirname(path), { persistent: false }, (_event, file) => {
          if (!file || [name, `${name}-wal`, `${name}-journal`].includes(String(file))) schedule();
        });
        watcher.on("error", recover);
        if (retry) {
          retry = undefined;
          schedule();
        }
      } catch (error) {
        recover(error instanceof Error ? error : new Error("Cannot watch database"));
      }
    };
    attach();
  }
  observers.set(sqlite, () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(retry);
    watcher?.close();
  });
}

export function stopChangeTracking(sqlite: Database): void {
  observers.get(sqlite)?.();
  observers.delete(sqlite);
}
