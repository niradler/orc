import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type GithubItem } from "@/api/client";
import { useTasks } from "@/hooks/useTasks";

export function GithubBoard({ projectId }: { projectId?: string }) {
  const [filter, setFilter] = useState("relevant");
  const [open, setOpen] = useState(false);
  const feed = useQuery({
    queryKey: ["github", projectId, filter],
    queryFn: () => api.git.githubItems(filter, projectId),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  return (
    <section className="border-b border-surface-highest p-3 text-xs space-y-2">
      <button
        type="button"
        data-testid="github-board-toggle"
        onClick={() => setOpen(!open)}
        className="text-primary"
      >
        {open ? "Hide GitHub" : "GitHub issues / PRs"}
      </button>
      {open && (
        <div data-testid="github-board" className="space-y-3">
          <div className="flex flex-wrap gap-3 items-center">
            <label>
              Show{" "}
              <select
                data-testid="github-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                className="bg-surface-highest p-1"
              >
                <option value="relevant">My work (branches + assignee + linked)</option>
                <option value="branches">Current branches / worktrees + linked</option>
                <option value="assigned">Assigned to me</option>
                <option value="all">All open items in known repositories</option>
              </select>
            </label>
            <button type="button" data-testid="github-refresh" onClick={() => void feed.refetch()}>
              Refresh
            </button>
            {feed.data?.login && (
              <span data-testid="github-auth">
                {feed.data.login} · {feed.data.auth}
              </span>
            )}
          </div>
          {feed.isFetching && <p>Loading GitHub…</p>}
          {feed.error && <p role="alert">{feed.error.message}</p>}
          {feed.data?.auth === "none" && (
            <p data-testid="github-no-auth">
              Sign in with gh auth login, or configure github.token / ORC_GITHUB_TOKEN on the API
              machine.
            </p>
          )}
          {feed.data?.auth !== "none" && feed.data?.items.length === 0 && (
            <p data-testid="github-empty">
              No matching open issues or PRs. Add a project repository folder, launch a terminal
              there, or choose a broader filter.
            </p>
          )}
          {feed.data?.truncated && (
            <p role="alert">
              Results limited by repository, pagination or request time budget. Narrow the project
              scope.
            </p>
          )}
          {feed.data?.errors.map((error) => (
            <p key={error.repo} role="alert">
              {error.repo}: {error.error}
            </p>
          ))}
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3 max-h-80 overflow-auto">
            {feed.data?.items.map((item) => (
              <GithubCard key={item.url} item={item} projectId={projectId} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function GithubCard({ item, projectId }: { item: GithubItem; projectId: string | undefined }) {
  const [taskId, setTaskId] = useState("");
  const client = useQueryClient();
  const tasks = useTasks(projectId ? { project_id: projectId } : undefined);
  const action = useMutation({
    mutationFn: async (create: boolean) => {
      const links = {
        [item.kind === "issue" ? "github_issue" : "github_pr"]: item.url,
        ...(item.branch ? { git_branch: item.branch } : {}),
      };
      if (create)
        return api.tasks.create({
          title: item.title,
          project_id: projectId,
          body: `${item.kind === "pr" ? "PR" : "Issue"} #${item.number}: ${item.url}`,
          ...links,
        });
      return api.tasks.update(taskId, links);
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["task"] });
      void client.invalidateQueries({ queryKey: ["github"] });
    },
  });
  return (
    <article
      data-testid="github-item"
      data-url={item.url}
      className="bg-surface-high p-3 border border-surface-highest rounded-sm space-y-2"
    >
      <a href={item.url} target="_blank" rel="noreferrer" className="text-primary">
        {item.kind === "pr" ? "PR" : "Issue"} #{item.number} · {item.repo}
      </a>
      <p>{item.title}</p>
      {item.branch && <p>{item.branch}</p>}
      <div className="flex gap-2">
        {item.task_ids.map((id) => (
          <Link
            key={id}
            data-testid="github-linked-task"
            to={`/tasks/${id}`}
            className="text-primary"
          >
            Open task
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <select
          data-testid="github-link-task"
          aria-label={`Link ${item.kind} ${item.number} to task`}
          value={taskId}
          onChange={(event) => setTaskId(event.target.value)}
          className="bg-surface-highest p-1 max-w-44"
        >
          <option value="">Choose task</option>
          {tasks.data?.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="github-link-save"
          disabled={!taskId || action.isPending}
          onClick={() => action.mutate(false)}
        >
          Link task
        </button>
        {!item.task_ids.length && (
          <button
            type="button"
            data-testid="github-create-task"
            disabled={action.isPending}
            onClick={() => action.mutate(true)}
            className="text-primary"
          >
            Create task
          </button>
        )}
      </div>
      {action.error && <p role="alert">{action.error.message}</p>}
    </article>
  );
}
