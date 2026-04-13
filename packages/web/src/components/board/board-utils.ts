import type { TaskStatus } from "@/api/client";

export const BOARD_COLUMNS: { status: TaskStatus; label: string; color: string }[] = [
  { status: "todo", label: "Todo", color: "#a6abbb" },
  { status: "queued", label: "Queued", color: "#549fff" },
  { status: "doing", label: "In Progress", color: "#78b0ff" },
  { status: "review", label: "Review", color: "#ffa851" },
  { status: "changes_requested", label: "Changes", color: "#eb8800" },
  { status: "blocked", label: "Blocked", color: "#ff716c" },
  { status: "done", label: "Done", color: "#70fda7" },
  { status: "paused", label: "Paused", color: "#707584" },
  { status: "cancelled", label: "Cancelled", color: "#434856" },
];

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["doing", "queued", "paused", "cancelled"],
  queued: ["doing", "todo", "cancelled"],
  doing: ["review", "blocked", "paused", "cancelled"],
  blocked: ["doing", "todo", "cancelled"],
  review: ["done", "changes_requested"],
  changes_requested: ["doing", "queued", "paused"],
  done: [],
  paused: ["todo"],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function validTargets(from: TaskStatus): TaskStatus[] {
  return TRANSITIONS[from] ?? [];
}

export const PRIORITY_COLORS: Record<string, string> = {
  critical: "#ff716c",
  high: "#ffa851",
  normal: "#78b0ff",
  low: "#707584",
};
