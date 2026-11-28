import type { AgentEvent, AgentPlanEntry, AgentPlanStatus } from "./types.js";

const PLAN_ENTRIES_MAX = 50;
const PLAN_CONTENT_MAX = 2000;

/** Providers spell the same status differently; unknown values fall back to pending. */
export function planStatus(value: unknown): AgentPlanStatus {
  const key = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (key === "inprogress" || key === "active" || key === "doing") return "in_progress";
  if (key === "completed" || key === "complete" || key === "done") return "completed";
  if (key === "failed" || key === "error" || key === "cancelled" || key === "blocked")
    return "failed";
  return "pending";
}

export type PlanEntryInput = {
  id?: unknown;
  status?: unknown;
  content?: unknown;
};

/**
 * One plan activity from provider entries. Entries without text are dropped and
 * an empty plan emits nothing, so a provider without a real plan stays silent.
 * Providers re-send the whole plan, so entries are identified by index unless
 * the provider supplies an id.
 */
export function planEvent(
  id: string,
  entries: readonly PlanEntryInput[],
  title?: string,
): AgentEvent | null {
  const planned = entries
    .map((entry, index) => ({
      id: entry.id === undefined ? String(index) : String(entry.id).slice(0, 200),
      status: planStatus(entry.status),
      content: typeof entry.content === "string" ? entry.content.slice(0, PLAN_CONTENT_MAX) : "",
    }))
    .filter((entry) => entry.content.trim())
    .slice(0, PLAN_ENTRIES_MAX);
  if (!planned.length) return null;
  return {
    type: "plan",
    data: { id, ...(title ? { title } : {}), entries: planned as AgentPlanEntry[] },
  };
}

/** The provider's last name segment, lowercased: `mcp__server__TaskCreate` -> `taskcreate`. */
function toolKey(name: string): string | undefined {
  return name
    .trim()
    .toLowerCase()
    .split(/__|:\s*|\.\s*/)
    .pop()
    ?.replace(/[^a-z_]/g, "");
}

const PLAN_TOOLS = new Set(["todowrite", "todo_write", "todo", "todos", "updatetodos"]);

/**
 * Claude's TodoWrite and OpenCode's todo tool carry the same checklist as a
 * tool call. Only a well-formed `todos` array becomes a plan; anything else is
 * left to the raw tool view.
 */
export function planFromToolInput(name: string, input: string): AgentEvent | null {
  const key = toolKey(name);
  if (!key || !PLAN_TOOLS.has(key)) return null;
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return null;
  }
  const todos = (value as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return null;
  return planEvent(
    "todos",
    todos.map((todo) => {
      const item = (todo && typeof todo === "object" ? todo : {}) as Record<string, unknown>;
      return { id: item.id, status: item.status, content: item.content ?? item.step };
    }),
  );
}

/** Claude's ID-based task tools: the checklist lives in tool results, not one snapshot. */
const TASK_TOOLS: Readonly<Record<string, "create" | "update" | "list">> = {
  taskcreate: "create",
  taskupdate: "update",
  tasklist: "list",
};

type TaskToolCall = {
  tool: "create" | "update" | "list";
  input: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Claude tracks work with TaskCreate / TaskUpdate / TaskList instead of re-sending
 * a TodoWrite snapshot. TaskCreate assigns the id in its result, TaskUpdate changes
 * one task and TaskList returns the current set, so accumulate those per turn and
 * emit the same `plan` snapshot the TodoWrite path produces.
 *
 * A deleted or failed task cannot be removed from the rendered checklist (plan
 * snapshots merge by id in `@orc/core/chat`), so deletion drops it from future
 * snapshots while the already-rendered row stays. That is preferable to showing
 * a task as completed when it was cancelled.
 */
export class PlanTracker {
  private readonly tasks = new Map<string, AgentPlanEntry>();
  private readonly calls = new Map<string, TaskToolCall>();
  private readonly applied = new Set<string>();

  /** Record a task tool call; its checklist change arrives with the result. */
  observeToolUse(toolUseId: string, name: string, input: unknown): void {
    const tool = TASK_TOOLS[toolKey(name) ?? ""];
    if (!tool) return;
    this.calls.set(toolUseId, { tool, input: asRecord(input) ?? {} });
  }

  /** Apply the tool's structured result and return the updated checklist, if any. */
  observeToolResult(toolUseId: string, result: unknown, isError = false): AgentEvent | null {
    const call = this.calls.get(toolUseId);
    if (!call || this.applied.has(toolUseId)) return null;
    this.calls.delete(toolUseId);
    this.applied.add(toolUseId);
    if (isError) return null;
    const changed =
      call.tool === "create"
        ? this.applyCreate(call.input, result)
        : call.tool === "update"
          ? this.applyUpdate(call.input, result)
          : this.applyList(result);
    return changed ? planEvent("tasks", [...this.tasks.values()], "Tasks") : null;
  }

  reset(): void {
    this.tasks.clear();
    this.calls.clear();
    this.applied.clear();
  }

  private applyCreate(input: Record<string, unknown>, result: unknown): boolean {
    const task = asRecord(asRecord(result)?.task);
    const id = asString(task?.id);
    const content = asString(task?.subject) ?? asString(input.subject);
    if (!id || !content) return false;
    this.tasks.set(id, { id, content: content.slice(0, PLAN_CONTENT_MAX), status: "pending" });
    return true;
  }

  private applyUpdate(input: Record<string, unknown>, result: unknown): boolean {
    const output = asRecord(result);
    if (output?.success === false) return false;
    const id = asString(input.taskId) ?? asString(output?.taskId);
    if (!id) return false;
    if (input.status === "deleted") {
      this.tasks.delete(id);
      return true;
    }
    const current = this.tasks.get(id);
    const content = asString(input.subject) ?? current?.content;
    if (!content) return false;
    this.tasks.set(id, {
      id,
      content: content.slice(0, PLAN_CONTENT_MAX),
      status:
        input.status === undefined ? (current?.status ?? "pending") : planStatus(input.status),
    });
    return true;
  }

  private applyList(result: unknown): boolean {
    const tasks = asRecord(result)?.tasks;
    if (!Array.isArray(tasks)) return false;
    this.tasks.clear();
    for (const value of tasks) {
      const item = asRecord(value);
      const id = asString(item?.id);
      const content = asString(item?.subject);
      if (!id || !content) continue;
      this.tasks.set(id, {
        id,
        content: content.slice(0, PLAN_CONTENT_MAX),
        status: planStatus(item?.status),
      });
    }
    return true;
  }
}
