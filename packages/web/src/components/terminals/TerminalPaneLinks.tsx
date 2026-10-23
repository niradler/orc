import { useQuery } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  GitPullRequest,
  ListTodo,
  LoaderCircle,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Terminal } from "@/api/client";
import { useTasks } from "@/hooks/useTasks";
import { workspaceDestination } from "@/lib/workspace-navigation";

function samePath(left: string | null | undefined, right: string): boolean {
  if (!left) return false;
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
  if (/^[A-Za-z]:[\\/]/.test(right))
    return normalize(left).toLowerCase() === normalize(right).toLowerCase();
  return normalize(left) === normalize(right);
}

export function TerminalPaneLinks({ terminal }: { terminal: Terminal }) {
  const [params] = useSearchParams();
  const tasks = useTasks();
  const status = useQuery({
    queryKey: ["git", terminal.id, "status"],
    queryFn: () => api.git.status(terminal.id),
  });
  const sessions = useQuery({
    queryKey: ["sessions", "live", false],
    queryFn: () => api.sessions.live({ active: false, limit: 5000 }),
    enabled: !!terminal.live_session_id,
    select: (data) => data.sessions,
  });
  const github = useQuery({
    queryKey: ["git", terminal.id, "github", status.data?.branch],
    queryFn: () => api.git.checkoutGithub(terminal.id),
    enabled: !!status.data?.root,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const checkout = status.data;
  const task =
    sessions.data?.find((session) => session.id === terminal.live_session_id)?.task ??
    tasks.data?.find(
      (task) =>
        checkout?.root &&
        checkout.branch &&
        task.git_branch === checkout.branch &&
        samePath(task.git_worktree ?? task.git_repo, checkout.root),
    );
  const pull = github.data?.items.find(
    (item) =>
      item.kind === "pr" &&
      item.branch === checkout?.branch &&
      /^https:\/\/github\.com\//.test(item.url),
  );
  const linkClass =
    "items-center gap-1.5 min-h-8 min-w-0 text-xs text-on-surface-variant hover:text-on-surface";
  return (
    <>
      {task && (
        <Link
          data-testid="pane-linked-task"
          to={workspaceDestination(
            `/tasks/${task.id}`,
            params.get("project") ?? "all",
            params.toString(),
          )}
          title={`ORC task: ${task.title}`}
          aria-label={`Open ORC task: ${task.title}`}
          className={`pane-task-context max-w-40 ${linkClass}`}
        >
          <ListTodo size={13} className="shrink-0" />
          <span className="truncate">{task.title}</span>
        </Link>
      )}
      {pull && (
        <div className="pane-pr-context items-center gap-2 shrink-0">
          <a
            data-testid="pane-linked-pr"
            href={pull.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`PR #${pull.number}: ${pull.title} (${pull.state})`}
            aria-label={`Open PR #${pull.number}: ${pull.title}`}
            className={`inline-flex shrink-0 ${linkClass}`}
          >
            <GitPullRequest size={13} />#{pull.number}
          </a>
          {github.data?.auth !== "none" &&
            pull.ci &&
            /^https:\/\/github\.com\//.test(pull.ci.url) && (
              <a
                data-testid="pane-ci-status"
                href={pull.ci.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`${pull.ci.total} checks/statuses on the PR's current commit`}
                aria-label={`CI ${pull.ci.state === "none" ? "has no checks" : pull.ci.state}`}
                className={`inline-flex items-center gap-1 text-xs ${pull.ci.state === "failure" ? "text-error" : pull.ci.state === "pending" ? "text-warning" : "text-on-surface-variant"}`}
              >
                {pull.ci.state === "success" ? (
                  <CircleCheck size={13} />
                ) : pull.ci.state === "failure" ? (
                  <CircleX size={13} />
                ) : pull.ci.state === "pending" ? (
                  <LoaderCircle size={13} />
                ) : (
                  <CircleDashed size={13} />
                )}
                {pull.ci.state === "none"
                  ? "No checks"
                  : `CI ${pull.ci.state === "success" ? "passed" : pull.ci.state === "failure" ? "failed" : "pending"}`}
              </a>
            )}
        </div>
      )}
    </>
  );
}
