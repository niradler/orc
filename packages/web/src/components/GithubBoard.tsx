import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitPullRequest, LoaderCircle } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { api, type GithubItem } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useTasks } from "@/hooks/useTasks";

export function GithubBoard({ projectId }: { projectId?: string }) {
  const [filter, setFilter] = useState("relevant");
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const scope = `${projectId ?? "all"}:`;
  const reportAction = (url: string, error: string | null) => {
    const key = `${scope}${url}`;
    setActionErrors((current) =>
      error
        ? { ...current, [key]: error }
        : Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key)),
    );
  };
  const feed = useQuery({
    queryKey: ["github", projectId, filter],
    queryFn: () => api.git.githubItems(filter, projectId),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="github-board-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="shrink-0"
      >
        {feed.isFetching ? (
          <LoaderCircle aria-hidden className="animate-spin" />
        ) : (
          <GitPullRequest aria-hidden className="hidden sm:block" />
        )}
        GitHub
        {feed.data && (
          <span className="text-xs text-outline">
            {feed.data.items.length}
            <span className="sr-only"> items</span>
          </span>
        )}
        <span className="sr-only"> issues and pull requests</span>
      </Button>
      {feed.isFetching && (
        <p role="status" className={open ? "order-last w-full text-xs text-outline" : "sr-only"}>
          Loading GitHub…
        </p>
      )}
      {feed.error && (
        <p role="alert" className="order-last w-full text-sm text-error">
          {feed.error.message}
        </p>
      )}
      {feed.data?.truncated && (
        <p role="alert" className="order-last w-full text-sm text-warning">
          Results limited by repository, pagination or request time budget. Narrow the project
          scope.
        </p>
      )}
      {feed.data?.errors.map((error) => (
        <p key={error.repo} role="alert" className="order-last w-full text-sm text-error">
          {error.repo}: {error.error}
        </p>
      ))}
      {Object.entries(actionErrors)
        .filter(([key]) => key.startsWith(scope))
        .map(([key, error]) => (
          <p key={key} role="alert" className="order-last w-full text-sm text-error">
            {error}
          </p>
        ))}
      <section
        id={panelId}
        data-testid="github-board"
        hidden={!open}
        aria-label="GitHub issues and pull requests"
        className="order-last w-full space-y-3 border-t border-border pt-3 text-sm"
      >
        {feed.data?.auth === "none" && (
          <p data-testid="github-no-auth" className="text-sm text-outline">
            Sign in with gh auth login, or configure github.token / ORC_GITHUB_TOKEN on the API
            machine.
          </p>
        )}
        <div className="flex flex-wrap gap-2 items-end">
          <label className="min-w-0 flex-1 text-xs text-outline">
            Show
            <select
              data-testid="github-filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="form-control form-control-single mt-1"
            >
              <option value="relevant">My work (branches + assignee + linked)</option>
              <option value="branches">Current branches / worktrees + linked</option>
              <option value="assigned">Assigned to me</option>
              <option value="all">All open items in known repositories</option>
            </select>
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="github-refresh"
            disabled={feed.isFetching}
            onClick={() => void feed.refetch()}
          >
            Refresh
          </Button>
          {feed.data?.login && (
            <span data-testid="github-auth" className="text-xs text-outline">
              {feed.data.login} · {feed.data.auth}
            </span>
          )}
        </div>
        {feed.data?.auth !== "none" && feed.data?.items.length === 0 && (
          <p data-testid="github-empty">
            No matching open issues or PRs. Add a project repository folder, launch a terminal
            there, or choose a broader filter.
          </p>
        )}
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3 max-h-80 overflow-auto">
          {feed.data?.items.map((item) => (
            <GithubCard
              key={item.url}
              item={item}
              projectId={projectId}
              onActionResult={reportAction}
            />
          ))}
        </div>
      </section>
    </>
  );
}

function GithubCard({
  item,
  projectId,
  onActionResult,
}: {
  item: GithubItem;
  projectId: string | undefined;
  onActionResult: (url: string, error: string | null) => void;
}) {
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
      onActionResult(item.url, null);
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["task"] });
      void client.invalidateQueries({ queryKey: ["github"] });
    },
    onError: (error) => onActionResult(item.url, `${item.repo} #${item.number}: ${error.message}`),
  });
  return (
    <article
      data-testid="github-item"
      data-url={item.url}
      className="bg-surface-high p-3 border border-surface-highest rounded-lg space-y-2"
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
          className="form-control form-control-single min-w-0 flex-1"
        >
          <option value="">Choose task</option>
          {tasks.data?.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
        <Button
          type="button"
          data-testid="github-link-save"
          variant="ghost"
          size="sm"
          disabled={!taskId || action.isPending}
          onClick={() => action.mutate(false)}
        >
          Link task
        </Button>
        {!item.task_ids.length && (
          <Button
            type="button"
            data-testid="github-create-task"
            variant="ghost"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate(true)}
            className="text-primary"
          >
            Create task
          </Button>
        )}
      </div>
    </article>
  );
}
