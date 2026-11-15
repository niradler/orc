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

const PLAN_TOOLS = new Set(["todowrite", "todo_write", "todo", "todos", "updatetodos"]);

/**
 * Claude's TodoWrite and OpenCode's todo tool carry the same checklist as a
 * tool call. Only a well-formed `todos` array becomes a plan; anything else is
 * left to the raw tool view.
 */
export function planFromToolInput(name: string, input: string): AgentEvent | null {
  const key = name
    .trim()
    .toLowerCase()
    .split(/__|:\s*|\.\s*/)
    .pop()
    ?.replace(/[^a-z_]/g, "");
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
