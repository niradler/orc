import type { TaskStatus } from "@/api/client";

// Visible kanban columns - the 5 statuses users actively manage.
// Internal/edge statuses (queued, changes_requested, paused, cancelled)
// are mapped into one of these for display via toVisibleStatus().
export type VisibleStatus = "todo" | "doing" | "review" | "blocked" | "done";

export const BOARD_COLUMNS: { status: VisibleStatus; label: string; color: string }[] = [
  { status: "todo", label: "Todo", color: "#a6abbb" },
  { status: "doing", label: "In Progress", color: "#78b0ff" },
  { status: "review", label: "Review", color: "#ffa851" },
  { status: "blocked", label: "Blocked", color: "#ff716c" },
  { status: "done", label: "Done", color: "#70fda7" },
];

export const VISIBLE_STATUSES: VisibleStatus[] = BOARD_COLUMNS.map((c) => c.status);

/**
 * Map any backend TaskStatus onto one of the five visible kanban columns.
 * - queued → doing (claimed by runner, effectively in progress)
 * - changes_requested → review (still part of the review cycle)
 * - paused → blocked (stalled / needs manual attention)
 * - cancelled → null (hidden from kanban)
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
      return "doing";
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

// Trello-like: any visible column accepts a card from any other column.
// Backend enforces integrity rules (e.g. blockers) via updateTaskStatus.
export function canTransition(_from: TaskStatus, _to: TaskStatus): boolean {
  return true;
}

export const PRIORITY_COLORS: Record<string, string> = {
  critical: "#ff716c",
  high: "#ffa851",
  normal: "#78b0ff",
  low: "#707584",
};
