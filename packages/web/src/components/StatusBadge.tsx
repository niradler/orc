import type { TaskStatus } from "@/api/client";
import { cn } from "@/lib/utils";

type JobStatus = "pending" | "running" | "success" | "failed" | "cancelled" | "skipped";

const TASK_COLORS: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground",
  queued: "bg-progress",
  doing: "bg-progress",
  review: "bg-tertiary",
  changes_requested: "bg-error",
  blocked: "bg-error",
  done: "bg-secondary",
  cancelled: "bg-muted-foreground",
  paused: "bg-muted-foreground",
};

const JOB_COLORS: Record<JobStatus, string> = {
  pending: "bg-muted-foreground",
  running: "bg-progress",
  success: "bg-secondary",
  failed: "bg-error",
  cancelled: "bg-muted-foreground",
  skipped: "bg-muted-foreground",
};

interface StatusBadgeProps {
  status: TaskStatus | JobStatus;
  type?: "task" | "job";
  className?: string;
}

export function StatusBadge({ status, type = "task", className }: StatusBadgeProps) {
  const colors =
    type === "job"
      ? (JOB_COLORS[status as JobStatus] ?? "bg-muted-foreground")
      : (TASK_COLORS[status as TaskStatus] ?? "bg-muted-foreground");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-label font-normal text-muted-foreground",
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full shrink-0", colors)} />
      {status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ")}
    </span>
  );
}
