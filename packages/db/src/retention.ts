import type { Database } from "bun:sqlite";
import { HumanRequestStore } from "./human-requests.js";
import { McpTaskStore } from "./mcp-tasks.js";

export const DEFAULT_REQUEST_RETENTION_DAYS = 7;
export const DEFAULT_MCP_TERMINAL_ROW_CAP = 2_000;
export const DEFAULT_INCREMENTAL_VACUUM_PAGES = 200;
/** Soft database cap; 0 disables the check. */
export const DEFAULT_DATABASE_SIZE_LIMIT_MB = 500;

/** Main database file size from the page count, without opening a second handle. */
export function databaseSizeBytes(sqlite: Database): number {
  const pageCount = sqlite.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count;
  const pageSize = sqlite.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size;
  return (pageCount ?? 0) * (pageSize ?? 0);
}

export type RetentionOptions = {
  now?: number;
  /** Terminal human requests and MCP tasks older than this are deleted. */
  requestRetentionDays?: number;
  /** Newest terminal MCP tasks to keep, whatever their age. */
  mcpTerminalRowCap?: number;
  /** Upper bound on pages freed in one pass. */
  vacuumPages?: number;
};

export type RetentionOutcome = {
  human_requests: number;
  mcp_tasks: number;
  vacuumed_pages: number;
};

function freelistCount(sqlite: Database): number {
  return (
    sqlite.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0
  );
}

/** 0 = none, 1 = full, 2 = incremental. */
export function autoVacuumMode(sqlite: Database): number {
  return sqlite.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum ?? 0;
}

/**
 * Frees at most `pages` pages. Only incremental auto-vacuum can do this in
 * bounded passes; a database created without it needs a one-time VACUUM first.
 */
export function incrementalVacuum(
  sqlite: Database,
  pages = DEFAULT_INCREMENTAL_VACUUM_PAGES,
): number {
  if (autoVacuumMode(sqlite) !== 2) return 0;
  const bounded = Math.max(0, Math.min(10_000, Math.floor(pages)));
  if (bounded === 0) return 0;
  const before = freelistCount(sqlite);
  if (before === 0) return 0;
  sqlite.exec(`PRAGMA incremental_vacuum(${bounded})`);
  return Math.max(0, before - freelistCount(sqlite));
}

/**
 * Daily database housekeeping: delete terminal rows no feature reads again,
 * then reclaim a bounded number of free pages and refresh planner statistics.
 * Safe to call repeatedly; pending and running work is never touched.
 */
export function pruneRetention(sqlite: Database, options: RetentionOptions = {}): RetentionOutcome {
  const now = options.now ?? Date.now();
  const requestDays = options.requestRetentionDays ?? DEFAULT_REQUEST_RETENTION_DAYS;
  const requests = new HumanRequestStore(sqlite, () => now).pruneTerminal(requestDays, now);
  const tasks = new McpTaskStore(sqlite);
  const expired = tasks.prune();
  // Rows without a per-task TTL (or older than it) still obey the request window.
  const aged = tasks.pruneTerminalOlderThan(now - requestDays * 86_400_000);
  const capped = tasks.pruneTerminal(options.mcpTerminalRowCap ?? DEFAULT_MCP_TERMINAL_ROW_CAP);
  sqlite.exec("PRAGMA optimize=0x10002");
  const vacuumed = incrementalVacuum(
    sqlite,
    options.vacuumPages ?? DEFAULT_INCREMENTAL_VACUUM_PAGES,
  );
  return {
    human_requests: requests,
    mcp_tasks: expired + aged + capped,
    vacuumed_pages: vacuumed,
  };
}
