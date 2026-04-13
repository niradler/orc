import type { TaskStatus } from "@/api/client";
import { cn } from "@/lib/utils";

type JobStatus = "pending" | "running" | "success" | "failed" | "cancelled" | "skipped";

const TASK_COLORS: Record<TaskStatus, string> = {
  todo: "bg-surface-highest text-on-surface-variant border-outline-variant",
  queued: "bg-primary/10 text-primary border-primary/30",
  doing: "bg-primary/15 text-primary border-primary/40",
  review: "bg-tertiary/15 text-tertiary border-tertiary/40",
  changes_requested: "bg-tertiary/10 text-tertiary border-tertiary/30",
  blocked: "bg-error/15 text-error border-error/40",
  done: "bg-secondary/15 text-secondary border-secondary/40",
  cancelled: "bg-surface-highest text-outline border-outline-variant",
  paused: "bg-surface-highest text-on-surface-variant border-outline-variant",
};

const JOB_COLORS: Record<JobStatus, string> = {
  pending: "bg-surface-highest text-on-surface-variant border-outline-variant",
  running: "bg-primary/15 text-primary border-primary/40",
  success: "bg-secondary/15 text-secondary border-secondary/40",
  failed: "bg-error/15 text-error border-error/40",
  cancelled: "bg-surface-highest text-outline border-outline-variant",
  skipped: "bg-surface-highest text-outline border-outline-variant",
};

interface StatusBadgeProps {
  status: TaskStatus | JobStatus;
  type?: "task" | "job";
  className?: string;
}

export function StatusBadge({ status, type = "task", className }: StatusBadgeProps) {
  const colors =
    type === "job"
      ? (JOB_COLORS[status as JobStatus] ?? "bg-surface-highest text-on-surface-variant")
      : (TASK_COLORS[status as TaskStatus] ?? "bg-surface-highest text-on-surface-variant");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-label font-semibold uppercase tracking-wider border",
        colors,
        className,
      )}
    >
      <span className="w-1.5 h-1.5 rounded-sm bg-current opacity-70 flex-shrink-0" />
      {status.replace(/_/g, " ")}
    </span>
  );
}
