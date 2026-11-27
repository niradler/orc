import type { Database } from "bun:sqlite";
import { ulid } from "@orc/core/ids";

/**
 * Durable state for MCP Tasks (both the SDK 2025-11-25 task-augmented flavor
 * and the io.modelcontextprotocol/tasks extension). Task IDs survive
 * disconnects and restarts; results stay available for the TTL after the task
 * reaches a terminal status.
 */
export type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";
export type McpTaskFlavor = "v1" | "v2";

export type McpTaskRow = {
  task_id: string;
  flavor: McpTaskFlavor;
  status: McpTaskStatus;
  status_message: string | null;
  ttl_ms: number | null;
  poll_interval_ms: number | null;
  owner: string;
  tool_name: string;
  result: string | null;
  error: string | null;
  input_requests: string | null;
  input_responses: string | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
};

export const MCP_TASK_DEFAULT_TTL_MS = 3_600_000;
export const MCP_TASK_MIN_TTL_MS = 60_000;
export const MCP_TASK_MAX_TTL_MS = 86_400_000;
const TERMINAL: ReadonlySet<McpTaskStatus> = new Set(["completed", "failed", "cancelled"]);

export function installMcpTasks(sqlite: Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS mcp_tasks (
    task_id TEXT PRIMARY KEY,
    flavor TEXT NOT NULL,
    status TEXT NOT NULL,
    status_message TEXT,
    ttl_ms INTEGER,
    poll_interval_ms INTEGER,
    owner TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    result TEXT,
    error TEXT,
    input_requests TEXT,
    input_responses TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    terminal_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS mcp_tasks_owner_idx ON mcp_tasks(owner, created_at);
  CREATE INDEX IF NOT EXISTS mcp_tasks_terminal_idx ON mcp_tasks(terminal_at)
    WHERE terminal_at IS NOT NULL;`);
}

export function clampTaskTtl(requested: number | null | undefined): number {
  if (requested === null) return MCP_TASK_MAX_TTL_MS;
  if (requested === undefined) return MCP_TASK_DEFAULT_TTL_MS;
  if (!Number.isFinite(requested)) return MCP_TASK_DEFAULT_TTL_MS;
  return Math.min(MCP_TASK_MAX_TTL_MS, Math.max(MCP_TASK_MIN_TTL_MS, Math.floor(requested)));
}

export class McpTaskStore {
  constructor(readonly sqlite: Database) {}

  create(input: {
    flavor: McpTaskFlavor;
    owner: string;
    toolName: string;
    ttlMs?: number | null | undefined;
    pollIntervalMs?: number | undefined;
  }): McpTaskRow {
    this.prune();
    const now = Date.now();
    const row: McpTaskRow = {
      task_id: ulid(),
      flavor: input.flavor,
      status: "working",
      status_message: null,
      ttl_ms: clampTaskTtl(input.ttlMs),
      poll_interval_ms: input.pollIntervalMs ?? 1000,
      owner: input.owner,
      tool_name: input.toolName,
      result: null,
      error: null,
      input_requests: null,
      input_responses: null,
      created_at: now,
      updated_at: now,
      terminal_at: null,
    };
    this.sqlite
      .query(
        `INSERT INTO mcp_tasks(task_id,flavor,status,status_message,ttl_ms,poll_interval_ms,owner,tool_name,result,error,input_requests,input_responses,created_at,updated_at,terminal_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.task_id,
        row.flavor,
        row.status,
        row.status_message,
        row.ttl_ms,
        row.poll_interval_ms,
        row.owner,
        row.tool_name,
        row.result,
        row.error,
        row.input_requests,
        row.input_responses,
        row.created_at,
        row.updated_at,
        row.terminal_at,
      );
    return row;
  }

  /** Expired terminal tasks are removed before lookup so IDs stop resolving. */
  get(taskId: string, owner: string): McpTaskRow | null {
    this.prune();
    return (
      this.sqlite
        .query<McpTaskRow, [string, string]>("SELECT * FROM mcp_tasks WHERE task_id=? AND owner=?")
        .get(taskId, owner) ?? null
    );
  }

  private transition(
    taskId: string,
    status: McpTaskStatus,
    fields: {
      status_message?: string | null;
      result?: string | null;
      error?: string | null;
      input_requests?: string | null;
    } = {},
  ): number {
    const now = Date.now();
    const terminal = TERMINAL.has(status);
    return this.sqlite
      .query(
        `UPDATE mcp_tasks SET status=?, status_message=COALESCE(?,status_message),
         result=COALESCE(?,result), error=COALESCE(?,error), input_requests=COALESCE(?,input_requests),
         updated_at=?, terminal_at=CASE WHEN ? THEN ? ELSE terminal_at END
         WHERE task_id=? AND terminal_at IS NULL`,
      )
      .run(
        status,
        fields.status_message ?? null,
        fields.result ?? null,
        fields.error ?? null,
        fields.input_requests ?? null,
        now,
        terminal ? 1 : 0,
        now,
        taskId,
      ).changes;
  }

  complete(taskId: string, result: unknown): void {
    this.transition(taskId, "completed", { result: JSON.stringify(result) });
  }

  fail(taskId: string, error: { code: number; message: string; data?: unknown }): void {
    this.transition(taskId, "failed", {
      error: JSON.stringify(error),
      status_message: error.message,
    });
  }

  cancel(taskId: string): boolean {
    return this.transition(taskId, "cancelled", { status_message: "Cancelled by client" }) > 0;
  }

  setInputRequests(taskId: string, requests: Record<string, unknown> | null): void {
    const now = Date.now();
    this.sqlite
      .query(
        "UPDATE mcp_tasks SET status='input_required', input_requests=?, updated_at=? WHERE task_id=? AND terminal_at IS NULL",
      )
      .run(requests === null ? null : JSON.stringify(requests), now, taskId);
  }

  applyInputResponses(
    taskId: string,
    responses: Record<string, unknown>,
  ): Record<string, unknown> | null {
    return this.sqlite
      .transaction(() => {
        const row = this.sqlite
          .query<{ input_responses: string | null }, [string]>(
            "SELECT input_responses FROM mcp_tasks WHERE task_id=? AND status='input_required' AND terminal_at IS NULL",
          )
          .get(taskId);
        if (!row) return null;
        const merged = {
          ...(JSON.parse(row.input_responses ?? "{}") as Record<string, unknown>),
          ...responses,
        };
        this.sqlite
          .query(
            "UPDATE mcp_tasks SET input_responses=?, updated_at=? WHERE task_id=? AND status='input_required' AND terminal_at IS NULL",
          )
          .run(JSON.stringify(merged), Date.now(), taskId);
        return merged;
      })
      .immediate();
  }

  resumeWorking(taskId: string): void {
    const now = Date.now();
    this.sqlite
      .query(
        "UPDATE mcp_tasks SET status='working', input_requests=NULL, updated_at=? WHERE task_id=? AND terminal_at IS NULL",
      )
      .run(now, taskId);
  }

  list(owner: string, cursor?: string): { tasks: McpTaskRow[]; nextCursor?: string | undefined } {
    this.prune();
    if (cursor !== undefined && !/^\d+$/.test(cursor)) {
      throw new Error(`Invalid cursor: ${cursor}`);
    }
    const offset = cursor !== undefined ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`Invalid cursor: ${cursor}`);
    const pageSize = 50;
    const tasks = this.sqlite
      .query<McpTaskRow, [string, number, number]>(
        "SELECT * FROM mcp_tasks WHERE owner=? ORDER BY created_at, task_id LIMIT ? OFFSET ?",
      )
      .all(owner, pageSize + 1, offset);
    const hasMore = tasks.length > pageSize;
    return {
      tasks: tasks.slice(0, pageSize),
      nextCursor: hasMore ? String(offset + pageSize) : undefined,
    };
  }

  prune(): number {
    const now = Date.now();
    return this.sqlite
      .query(
        "DELETE FROM mcp_tasks WHERE terminal_at IS NOT NULL AND ttl_ms IS NOT NULL AND terminal_at + ttl_ms < ?",
      )
      .run(now).changes;
  }

  /**
   * Keeps the newest `maxRows` terminal tasks. TTL expiry alone is unbounded:
   * clients can request a 24h TTL, and a busy install creates rows faster than
   * they age out. Returns how many rows this cap removed.
   */
  /** Terminal tasks last touched before `cutoffMs` (epoch ms), regardless of their own TTL. */
  pruneTerminalOlderThan(cutoffMs: number): number {
    if (!Number.isFinite(cutoffMs)) return 0;
    return this.sqlite
      .query("DELETE FROM mcp_tasks WHERE terminal_at IS NOT NULL AND terminal_at < ?")
      .run(cutoffMs).changes;
  }

  pruneTerminal(maxRows: number): number {
    if (!Number.isInteger(maxRows) || maxRows < 1) return 0;
    return this.sqlite
      .query(
        `DELETE FROM mcp_tasks
         WHERE terminal_at IS NOT NULL AND task_id NOT IN (
           SELECT task_id FROM mcp_tasks
           WHERE terminal_at IS NOT NULL
           ORDER BY terminal_at DESC, task_id DESC
           LIMIT ?
         )`,
      )
      .run(maxRows).changes;
  }

  /** A restart kills in-flight executions; surface that honestly to pollers. */
  failOrphans(): number {
    const now = Date.now();
    const result = this.sqlite
      .query(
        `UPDATE mcp_tasks SET status='failed',
         error=?, status_message='ORC restarted before this task finished',
         updated_at=?, terminal_at=? WHERE terminal_at IS NULL`,
      )
      .run(
        JSON.stringify({ code: -32603, message: "ORC restarted before this task finished" }),
        now,
        now,
      );
    return result.changes;
  }
}
