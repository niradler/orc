import type { Database } from "bun:sqlite";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { type CallToolRequest, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getSqlite } from "@orc/db/client";
import { type McpTaskRow, McpTaskStore } from "@orc/db/mcp-tasks";
import { z } from "zod";
import type { ToolResult } from "./meta-tools.js";

/**
 * MCP Tasks: durable handles for long-running tool calls. Two wire flavors share
 * one SQLite-backed store:
 *  - v1: the SDK 2025-11-25 task-augmented request (`params.task` → `{task}`,
 *    polled with tasks/get, payload fetched with tasks/result).
 *  - v2: the io.modelcontextprotocol/tasks extension (client opts in via
 *    `_meta` clientCapabilities; server returns `resultType:"task"`, polled with
 *    tasks/get which carries the final result inline, plus tasks/update).
 * The flavor is recorded at creation; tasks/get and tasks/cancel answer in the
 * shape of the task being addressed.
 */
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

// Cancellation must reach a running execution even when the cancel arrives on a
// different (stateless HTTP) server instance, so controllers live per process.
const running = new Map<string, AbortController>();
const orphansFailedFor = new WeakSet<Database>();

const TaskIdParams = z.object({ taskId: z.string().min(1) });
const GetTaskRequestSchema = z.object({
  method: z.literal("tasks/get"),
  params: TaskIdParams,
});
const GetTaskPayloadRequestSchema = z.object({
  method: z.literal("tasks/result"),
  params: TaskIdParams,
});
const ListTasksRequestSchema = z.object({
  method: z.literal("tasks/list"),
  params: z.object({ cursor: z.string().optional() }).optional(),
});
const CancelTaskRequestSchema = z.object({
  method: z.literal("tasks/cancel"),
  params: TaskIdParams,
});
const UpdateTaskRequestSchema = z.object({
  method: z.literal("tasks/update"),
  params: TaskIdParams.extend({
    inputResponses: z.record(z.string(), z.unknown()).default({}),
  }),
});

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function v1Task(row: McpTaskRow) {
  return {
    taskId: row.task_id,
    status: row.status,
    ttl: row.ttl_ms,
    createdAt: iso(row.created_at),
    lastUpdatedAt: iso(row.updated_at),
    ...(row.poll_interval_ms !== null ? { pollInterval: row.poll_interval_ms } : {}),
    ...(row.status_message !== null ? { statusMessage: row.status_message } : {}),
  };
}

function v2Task(row: McpTaskRow) {
  const base = {
    resultType: "complete" as const,
    taskId: row.task_id,
    status: row.status,
    createdAt: iso(row.created_at),
    lastUpdatedAt: iso(row.updated_at),
    ttlMs: row.ttl_ms,
    ...(row.poll_interval_ms !== null ? { pollIntervalMs: row.poll_interval_ms } : {}),
    ...(row.status_message !== null ? { statusMessage: row.status_message } : {}),
  };
  if (row.status === "input_required")
    return { ...base, inputRequests: JSON.parse(row.input_requests ?? "{}") };
  if (row.status === "completed") return { ...base, result: JSON.parse(row.result ?? "{}") };
  if (row.status === "failed")
    return { ...base, error: JSON.parse(row.error ?? '{"code":-32603,"message":"Unknown error"}') };
  return base;
}

function v2Create(row: McpTaskRow) {
  return {
    resultType: "task" as const,
    taskId: row.task_id,
    status: row.status,
    createdAt: iso(row.created_at),
    lastUpdatedAt: iso(row.updated_at),
    ttlMs: row.ttl_ms,
    ...(row.poll_interval_ms !== null ? { pollIntervalMs: row.poll_interval_ms } : {}),
  };
}

export interface McpTasksOptions {
  /** Identity the task is bound to (project-scope key or "global"). */
  owner: string;
  /** Tools the server will run as a task for a v2-opted-in client (server-directed). */
  eligibleTools: ReadonlySet<string>;
  store?: McpTaskStore | undefined;
}

/**
 * Decide whether a tools/call should become a task and, if so, durably create it
 * and start the work in the background. Returns the CreateTaskResult to send
 * immediately, or null to run the call synchronously.
 */
export function maybeAugmentCallTool(
  request: CallToolRequest,
  run: (signal: AbortSignal) => Promise<ToolResult>,
  options: McpTasksOptions,
): { task: ReturnType<typeof v1Task> } | ReturnType<typeof v2Create> | null {
  const store = options.store ?? new McpTaskStore(getSqlite());
  const params = request.params;
  const clientCaps = params._meta?.[CLIENT_CAPABILITIES_META_KEY] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  const v2OptIn = clientCaps?.extensions?.[TASKS_EXTENSION_ID] !== undefined;

  let flavor: "v1" | "v2";
  let requestedTtl: number | null | undefined;
  if (params.task) {
    flavor = "v1";
    requestedTtl = params.task.ttl;
  } else if (v2OptIn && options.eligibleTools.has(params.name)) {
    flavor = "v2";
    requestedTtl = undefined;
  } else {
    return null;
  }

  // Durable before the handle is sent, so a crash never loses an accepted task.
  const row = store.create({
    flavor,
    owner: options.owner,
    toolName: params.name,
    ttlMs: requestedTtl,
  });
  const controller = new AbortController();
  running.set(row.task_id, controller);
  void (async () => {
    try {
      const result = await run(controller.signal);
      if (store.get(row.task_id, options.owner)?.status === "cancelled") return;
      store.complete(row.task_id, result);
    } catch (err) {
      store.fail(row.task_id, {
        code: err instanceof McpError ? err.code : ErrorCode.InternalError,
        message: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      running.delete(row.task_id);
    }
  })();

  return flavor === "v1" ? { task: v1Task(row) } : v2Create(row);
}

export function registerMcpTasks(server: Server, options: McpTasksOptions): void {
  const store = options.store ?? new McpTaskStore(getSqlite());
  if (!orphansFailedFor.has(store.sqlite)) {
    orphansFailedFor.add(store.sqlite);
    store.failOrphans();
  }

  function requireTask(taskId: string): McpTaskRow {
    const row = store.get(taskId, options.owner);
    if (!row) throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
    return row;
  }

  server.setRequestHandler(GetTaskRequestSchema, async (request) => {
    const row = requireTask(request.params.taskId);
    return row.flavor === "v1" ? v1Task(row) : v2Task(row);
  });

  server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
    const row = requireTask(request.params.taskId);
    if (row.status === "completed") return JSON.parse(row.result ?? "{}");
    if (row.status === "failed") {
      const error = JSON.parse(row.error ?? '{"code":-32603,"message":"Unknown error"}');
      throw new McpError(error.code ?? ErrorCode.InternalError, error.message ?? "Task failed");
    }
    if (row.status === "cancelled") {
      throw new McpError(ErrorCode.InvalidParams, `Task was cancelled: ${row.task_id}`);
    }
    throw new McpError(ErrorCode.InvalidParams, `Task result not available yet: ${row.task_id}`);
  });

  server.setRequestHandler(ListTasksRequestSchema, async (request) => {
    let listed: ReturnType<McpTaskStore["list"]>;
    try {
      listed = store.list(options.owner, request.params?.cursor);
    } catch (err) {
      throw new McpError(
        ErrorCode.InvalidParams,
        err instanceof Error ? err.message : "Invalid cursor",
      );
    }
    return {
      tasks: listed.tasks.map(v1Task),
      ...(listed.nextCursor !== undefined ? { nextCursor: listed.nextCursor } : {}),
    };
  });

  server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
    const row = requireTask(request.params.taskId);
    const terminal = ["completed", "failed", "cancelled"].includes(row.status);
    if (row.flavor === "v1" && terminal)
      throw new McpError(
        ErrorCode.InvalidParams,
        `Cannot cancel task in terminal status: ${row.status}`,
      );
    if (!terminal) {
      const cancelled = store.cancel(row.task_id);
      if (cancelled) {
        running.get(row.task_id)?.abort();
      } else if (row.flavor === "v1") {
        const latest = requireTask(row.task_id);
        throw new McpError(
          ErrorCode.InvalidParams,
          `Cannot cancel task in terminal status: ${latest.status}`,
        );
      }
    }
    const updated = requireTask(row.task_id);
    return row.flavor === "v1" ? v1Task(updated) : { resultType: "complete" as const };
  });

  server.setRequestHandler(UpdateTaskRequestSchema, async (request) => {
    const row = requireTask(request.params.taskId);
    if (row.flavor !== "v2")
      throw new McpError(
        ErrorCode.InvalidParams,
        `tasks/update applies to extension tasks: ${row.task_id}`,
      );
    if (row.status === "input_required") {
      const outstanding = JSON.parse(row.input_requests ?? "{}") as Record<string, unknown>;
      const responses: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(request.params.inputResponses)) {
        if (Object.hasOwn(outstanding, key)) responses[key] = value;
      }
      store.applyInputResponses(row.task_id, responses);
    }
    return { resultType: "complete" as const };
  });
}
