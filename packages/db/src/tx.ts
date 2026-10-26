import type { Database } from "bun:sqlite";
import { getDb, getSqlite, type OrcDb } from "./client.js";

export type OrcTx = Parameters<Parameters<OrcDb["transaction"]>[0]>[0];

/** Rejects promise-returning callbacks at compile time. */
type Sync<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * Runs `fn` in one IMMEDIATE transaction on the shared connection.
 *
 * bun:sqlite transactions are synchronous: an async callback commits at its first
 * `await` and runs the rest outside the transaction, so the callback must be sync
 * and finish queries with `.run()` / `.get()` / `.all()`. Nested calls become
 * savepoints.
 */
export function withTx<T>(fn: (tx: OrcTx) => Sync<T>, db: OrcDb = getDb()): T {
  return db.transaction(fn, { behavior: "immediate" }) as T;
}

/** {@link withTx} for raw bun:sqlite statements. */
export function withSqliteTx<T>(fn: () => Sync<T>, sqlite: Database = getSqlite()): T {
  return sqlite.transaction(fn).immediate() as T;
}

/**
 * Deletes a job; its runs cascade. Sessions and bridge rows reference runs without
 * ON DELETE in existing databases, so they are detached in the same transaction.
 */
export function deleteJob(jobId: string, sqlite: Database = getSqlite()): void {
  withSqliteTx(() => {
    for (const table of ["sessions", "bridge_messages", "bridge_permissions"])
      sqlite
        .query(
          `UPDATE ${table} SET job_run_id = NULL WHERE job_run_id IN (SELECT id FROM job_runs WHERE job_id = ?)`,
        )
        .run(jobId);
    sqlite.query("DELETE FROM jobs WHERE id = ?").run(jobId);
  }, sqlite);
}
