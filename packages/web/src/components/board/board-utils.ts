import type { TaskStatus } from "@/api/client";

// Visible kanban columns - the 5 statuses users actively manage.
// Internal/edge statuses (queued, changes_requested, paused, cancelled)
// are mapped into one of these for display via toVisibleStatus(). A card whose
// real status differs from its column carries a badge (see KanbanCard) so the
// mapping never hides which state the task is really in.
export type VisibleStatus = "todo" | "doing" | "review" | "blocked" | "done";

export const BOARD_COLUMNS: {
  status: VisibleStatus;
  label: string;
  color: string;
}[] = [
  { status: "todo", label: "Todo", color: "rgb(var(--muted-foreground))" },
  { status: "doing", label: "In Progress", color: "rgb(var(--progress))" },
  { status: "review", label: "Review", color: "rgb(var(--warning))" },
  { status: "blocked", label: "Blocked", color: "rgb(var(--error))" },
  { status: "done", label: "Done", color: "rgb(var(--success))" },
];

export const VISIBLE_STATUSES: VisibleStatus[] = BOARD_COLUMNS.map((c) => c.status);

/**
 * Map any backend TaskStatus onto one of the five visible kanban columns.
 * - queued → todo (waiting for a worker slot, nobody is working on it yet)
 * - changes_requested → review (still part of the review cycle)
 * - paused → blocked (stalled / needs manual attention)
 * - cancelled → null (hidden from kanban)
 *
 * `queued` belongs in Todo, not In Progress. The flow runner sets it when a node
 * is waiting for a worker slot and clears it to the node's own status once the
 * session actually starts (`flow-runner.ts`, "a queued agent node is not being
 * worked on yet"). Showing it as In Progress made the board claim more work in
 * flight than `agent_loop.max_workers` allows - which is the whole reason the
 * runner routes through `queued` in the first place. The Dashboard already
 * counted it with todo; this is the surface that disagreed.
 */
export function toVisibleStatus(status: TaskStatus): VisibleStatus | null {
  switch (status) {
    case "todo":
    case "doing":
    case "review":
    case "blocked":
    case "done":
      return status;
    case "queued":
      return "todo";
    case "changes_requested":
      return "review";
    case "paused":
      return "blocked";
    case "cancelled":
      return null;
    default:
      return null;
  }
}

/**
 * Label for a status that is displayed in a column named something else, so the
 * card can say what it really is. Null when column and status already agree.
 */
export function mappedStatusLabel(status: TaskStatus): string | null {
  const visible = toVisibleStatus(status);
  if (visible === null || visible === status) return null;
  return status.replace(/_/g, " ");
}

// Trello-like: any visible column accepts a card from any other column.
// Backend enforces integrity rules (e.g. blockers) via updateTaskStatus.
export function canTransition(_from: TaskStatus, _to: TaskStatus): boolean {
  return true;
}

export const PRIORITY_COLORS: Record<string, string> = {
  critical: "rgb(var(--error))",
  high: "rgb(var(--warning))",
  normal: "rgb(var(--muted-foreground))",
  low: "rgb(var(--muted-foreground))",
};
