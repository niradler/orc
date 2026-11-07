import type { Task } from "@/api/client";

export function GithubTaskBadge({ task }: { task: Task }) {
  if (!task.github_sync) return null;
  return (
    <span
      data-testid="github-task-badge"
      className={task.github_sync.error ? "text-xs text-error" : "text-xs text-muted-foreground"}
      title={
        task.github_sync.error ??
        (task.status !== task.github_sync.status
          ? "Status awaiting GitHub sync"
          : "Linked GitHub issue")
      }
    >
      GitHub #{task.github_sync.number}
      {task.github_sync.error
        ? " · sync error"
        : task.status !== task.github_sync.status
          ? " · pending"
          : ""}
    </span>
  );
}
