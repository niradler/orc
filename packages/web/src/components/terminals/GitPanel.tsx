import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Terminal } from "@/api/client";
import { useTasks, useUpdateTask } from "@/hooks/useTasks";
import { useTerminals } from "@/lib/terminals";

export function GitPanel({ terminal }: { terminal: Terminal }) {
  const [open, setOpen] = useState(false);
  return (
    <aside className="shrink-0 border-l border-surface-highest flex flex-col min-h-0">
      <button
        type="button"
        data-testid="terminal-git-toggle"
        aria-label={open ? "Collapse git panel" : "Expand git panel"}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="p-3 text-primary"
      >
        <GitBranch size={16} />
      </button>
      {open && <GitPanelBody key={terminal.id} terminal={terminal} />}
    </aside>
  );
}

function GitPanelBody({ terminal }: { terminal: Terminal }) {
  const { create } = useTerminals();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [tab, setTab] = useState("status");
  const [staged, setStaged] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [taskId, setTaskId] = useState("");
  const status = useQuery({
    queryKey: ["git", terminal.id, "status"],
    queryFn: () => api.git.status(terminal.id),
    refetchInterval: 5_000,
  });
  const diff = useQuery({
    queryKey: ["git", terminal.id, "diff", staged],
    queryFn: () => api.git.diff(terminal.id, staged),
    enabled: tab === "diff",
    refetchInterval: 5_000,
  });
  const trees = useQuery({
    queryKey: ["worktrees", terminal.id],
    queryFn: () => api.git.terminalWorktrees(terminal.id),
    enabled: tab === "branches",
    refetchInterval: 10_000,
  });
  const tasks = useTasks();
  const updateTask = useUpdateTask();
  const action = useMutation({
    mutationFn: async (kind: "stage" | "commit" | "worktree") => {
      if (kind === "stage") return api.git.stage(terminal.id, paths);
      if (kind === "commit") return api.git.commit(terminal.id, message);
      return api.git.addWorktree(terminal.id);
    },
    onSuccess: (_data, kind) => {
      if (kind === "stage") setPaths([]);
      if (kind === "commit") setMessage("");
      void client.invalidateQueries({ queryKey: ["git", terminal.id] });
      void client.invalidateQueries({ queryKey: ["worktrees"] });
    },
  });
  const openShell = useMutation({
    mutationFn: (cwd: string) => create({ kind: "shell", cwd }),
    onSuccess: (created) => navigate(`/terminals/${created.id}`),
  });
  const data = status.data;
  return (
    <div
      data-testid="terminal-git-panel"
      className="w-80 max-w-[55vw] flex-1 overflow-auto p-3 space-y-3 text-xs"
    >
      <div className="flex justify-between">
        <strong>{data?.branch ?? "Git"}</strong>
        <button
          type="button"
          data-testid="git-refresh"
          onClick={() => {
            void status.refetch();
            void diff.refetch();
          }}
        >
          Refresh
        </button>
      </div>
      {status.error && <p role="alert">{status.error.message}</p>}
      {data && !data.root && <p>This folder is not a git repository.</p>}
      {data?.root && (
        <>
          <p className="break-all text-outline">{data.root}</p>
          <div className="flex gap-3">
            {["status", "diff", "branches"].map((name) => (
              <button
                type="button"
                data-testid={`git-tab-${name}`}
                key={name}
                aria-pressed={tab === name}
                onClick={() => setTab(name)}
                className={tab === name ? "text-primary" : "text-outline"}
              >
                {name}
              </button>
            ))}
          </div>
          {tab === "status" && (
            <div className="space-y-2">
              {data.files.length === 0 && <p data-testid="git-clean">Working tree clean</p>}
              {data.files.map((file) => (
                <label
                  key={file.path}
                  data-testid="git-status-file"
                  className="flex gap-2 break-all"
                >
                  <input
                    type="checkbox"
                    checked={paths.includes(file.path)}
                    onChange={(event) =>
                      setPaths((old) =>
                        event.target.checked
                          ? [...old, file.path, ...(file.original ? [file.original] : [])]
                          : old.filter((path) => path !== file.path && path !== file.original),
                      )
                    }
                  />
                  <code>
                    {file.index}
                    {file.working}
                  </code>
                  {file.path}
                </label>
              ))}
              <button
                type="button"
                data-testid="git-stage"
                disabled={!paths.length || action.isPending}
                onClick={() => action.mutate("stage")}
                className="text-primary disabled:opacity-40"
              >
                Stage selected
              </button>
              <input
                aria-label="Commit message"
                data-testid="git-commit-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Commit message"
                className="w-full bg-surface-highest p-2"
              />
              <button
                type="button"
                data-testid="git-commit"
                disabled={
                  !message.trim() ||
                  action.isPending ||
                  !data.files.some((file) => file.index !== " " && file.index !== "?")
                }
                onClick={() => action.mutate("commit")}
                className="text-primary disabled:opacity-40"
              >
                Commit staged changes
              </button>
            </div>
          )}
          {tab === "diff" && (
            <div className="space-y-2">
              <label className="flex gap-2">
                <input
                  data-testid="git-diff-staged"
                  type="checkbox"
                  checked={staged}
                  onChange={(event) => setStaged(event.target.checked)}
                />
                Staged changes
              </label>
              {diff.error && <p role="alert">{diff.error.message}</p>}
              <pre data-testid="git-diff" className="overflow-auto text-[10px] whitespace-pre">
                {diff.data?.diff || "No diff (untracked files appear in status)."}
              </pre>
              {diff.data?.truncated && <p>Diff truncated at 200 KB.</p>}
            </div>
          )}
          {tab === "branches" && (
            <div className="space-y-2">
              <p>Local branches</p>
              {data.branches.map((branch) => (
                <p key={branch}>{branch}</p>
              ))}
              <p>Worktrees</p>
              {trees.error && <p role="alert">{trees.error.message}</p>}
              {trees.data?.worktrees.map((tree) => (
                <div key={tree.path} data-testid="git-panel-worktree" className="break-all">
                  <strong>{tree.branch ?? "detached"}</strong>
                  <p>{tree.path}</p>
                  {tree.dirty && <span>dirty · </span>}
                  {tree.active_terminal && <span>running · </span>}
                  {!tree.main && (
                    <button type="button" onClick={() => openShell.mutate(tree.path)}>
                      Open shell here
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                data-testid="git-add-worktree"
                disabled={action.isPending}
                onClick={() => action.mutate("worktree")}
                className="text-primary"
              >
                New orc worktree
              </button>
              <p>Use Manage worktrees in the terminal list for safe removal.</p>
            </div>
          )}
          <div className="border-t border-surface-highest pt-3 space-y-2">
            <label>
              Link to task
              <select
                aria-label="Task to link"
                data-testid="git-link-task"
                className="w-full bg-surface-highest p-2"
                value={taskId}
                onChange={(event) => setTaskId(event.target.value)}
              >
                <option value="">Choose task</option>
                {tasks.data?.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              data-testid="git-link-save"
              disabled={!taskId || updateTask.isPending}
              onClick={() =>
                updateTask.mutate({
                  id: taskId,
                  git_repo: data.root,
                  git_branch: data.branch,
                  git_worktree: terminal.cwd,
                })
              }
              className="text-primary"
            >
              Link this checkout
            </button>
            {updateTask.isSuccess && (
              <Link data-testid="git-linked-task" to={`/tasks/${taskId}`}>
                Open linked task
              </Link>
            )}
            {updateTask.error && <p role="alert">{updateTask.error.message}</p>}
          </div>
        </>
      )}
      {action.error && <p role="alert">{action.error.message}</p>}
      {openShell.error && <p role="alert">{openShell.error.message}</p>}
    </div>
  );
}
