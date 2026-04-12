import { cn } from "@/lib/utils";
import type { TaskPriority } from "@/api/client";

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  critical: "text-error font-bold",
  high: "text-tertiary font-semibold",
  normal: "text-on-surface-variant",
  low: "text-outline",
};

export function PriorityBadge({ priority, className }: { priority: TaskPriority; className?: string }) {
  return (
    <span className={cn("font-label text-xs uppercase tracking-wide", PRIORITY_COLORS[priority], className)}>
      {priority}
    </span>
  );
}
