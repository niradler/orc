import type { Database } from "bun:sqlite";
import { ConflictError } from "@orc/core/errors";
import { createLogger } from "@orc/core/logger";
import { ttlDeadline } from "@orc/core/ttl";

const logger = createLogger("db:ttl");

/**
 * Recoverable-delete TTL.
 *
 * Tables that use the shared lifecycle store `archived_at` (when the delete happened)
 * and `delete_after` (when the maintenance sweep may purge the row). Callers archive
 * the row immediately, then either restore it (clearing both columns) or let the sweep
 * call their purge. New resources should add the two columns and register a sweep in
 * the API's TTL module rather than writing another expiration loop.
 */

/** A table that stores the shared archived_at/delete_after pair. Identifiers are code constants. */
export type TtlColumns = {
  table: string;
};

export type TtlTable = TtlColumns & {
  /** Column logged when a row is purged or its schedule is cancelled, e.g. `name`. */
  labelColumn: string;
};

export type TtlSweep = TtlTable & {
  /** Resource name used in sweep results, e.g. "project". */
  resource: string;
  /** Permanently remove the row. Throwing keeps it archived and cancels its schedule. */
  purge(id: string): void;
};

export type TtlSweepOutcome = {
  purged: { resource: string; id: string; label: string }[];
  cancelled: { resource: string; id: string; label: string; reason: string }[];
  /** Transient purge failures; the schedule stays set so the next sweep retries. */
  failed: { resource: string; id: string; label: string; reason: string }[];
};

export type TtlClock = {
  /** Seconds since the epoch. */
  archived_at: number;
  /** Seconds since the epoch. */
  delete_after: number;
};

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function column(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid TTL column: ${value}`);
  return value;
}

function table(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid TTL table: ${value}`);
  return value;
}

function extraAssignments(extra: Record<string, string | number | null> | undefined): {
  sql: string;
  values: (string | number | null)[];
} {
  const entries = Object.entries(extra ?? {});
  return {
    sql: entries.map(([name]) => `,${column(name)}=?`).join(""),
    values: entries.map(([, value]) => value),
  };
}

/** Rows whose scheduled deletion has come due, oldest deadline first. */
export function dueTtlRows(sqlite: Database, spec: TtlTable): { id: string; label: string }[] {
  return sqlite
    .query<{ id: string; label: string }, []>(
      `SELECT id, ${column(spec.labelColumn)} AS label FROM ${table(spec.table)}
       WHERE delete_after IS NOT NULL AND delete_after <= unixepoch()
       ORDER BY delete_after`,
    )
    .all();
}

/**
 * Archives a row and schedules its purge. An existing archived_at is kept so a
 * re-scheduled delete does not pretend the row was archived later than it was.
 */
export function scheduleTtl(
  sqlite: Database,
  input: TtlColumns & {
    id: string;
    ttlDays: number;
    /** Resource columns set in the same statement, e.g. projects.status. */
    extra?: Record<string, string | number | null>;
    now?: Date;
  },
): TtlClock {
  const now = input.now ?? new Date();
  const archivedAt = Math.floor(now.getTime() / 1000);
  const deleteAfter = Math.floor(ttlDeadline(input.ttlDays, now).getTime() / 1000);
  const extra = extraAssignments(input.extra);
  const { changes } = sqlite
    .query(
      `UPDATE ${table(input.table)}
       SET archived_at=COALESCE(archived_at, ?), delete_after=?${extra.sql}
       WHERE id=?`,
    )
    .run(archivedAt, deleteAfter, ...extra.values, input.id);
  if (!changes) throw new Error(`${input.table} row not found: ${input.id}`);
  return { archived_at: archivedAt, delete_after: deleteAfter };
}

/** Clears the schedule and archive marker after the grace period. */
export function restoreTtl(
  sqlite: Database,
  input: TtlColumns & {
    id: string;
    /** Resource columns set in the same statement, e.g. projects.status. */
    extra?: Record<string, string | number | null>;
  },
): void {
  const extra = extraAssignments(input.extra);
  const { changes } = sqlite
    .query(
      `UPDATE ${table(input.table)} SET archived_at=NULL, delete_after=NULL${extra.sql} WHERE id=?`,
    )
    .run(...extra.values, input.id);
  if (!changes) throw new Error(`${input.table} row not found: ${input.id}`);
}

/** Drops only the schedule, keeping the row archived. Used when a purge refuses. */
export function cancelScheduledTtl(sqlite: Database, spec: TtlColumns & { id: string }): void {
  sqlite.query(`UPDATE ${table(spec.table)} SET delete_after=NULL WHERE id=?`).run(spec.id);
}

/**
 * Purges every due row for each registered resource. A deliberate ConflictError (for
 * example the row gained a linked knowledge base) leaves it archived and clears the
 * schedule so the same refusal is not retried every minute. Any other failure leaves
 * the schedule in place for the next sweep.
 */
export function sweepTtl(sqlite: Database, sweeps: TtlSweep[]): TtlSweepOutcome {
  const outcome: TtlSweepOutcome = { purged: [], cancelled: [], failed: [] };
  for (const sweep of sweeps) {
    for (const row of dueTtlRows(sqlite, sweep)) {
      try {
        sweep.purge(row.id);
        outcome.purged.push({ resource: sweep.resource, id: row.id, label: row.label });
        logger.info(`Purged ${sweep.resource} ${row.label} after its delete-after date`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof ConflictError) {
          cancelScheduledTtl(sqlite, { ...sweep, id: row.id });
          outcome.cancelled.push({
            resource: sweep.resource,
            id: row.id,
            label: row.label,
            reason,
          });
          logger.warn(
            `Scheduled deletion of ${sweep.resource} ${row.label} was cancelled: ${reason}`,
          );
        } else {
          outcome.failed.push({ resource: sweep.resource, id: row.id, label: row.label, reason });
          logger.error(
            `Purging ${sweep.resource} ${row.label} failed; the next sweep will retry: ${reason}`,
          );
        }
      }
    }
  }
  return outcome;
}
