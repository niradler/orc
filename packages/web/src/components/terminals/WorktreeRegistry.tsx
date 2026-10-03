import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Worktree } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export function WorktreeRegistry() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Record<string, { cwd: string; path: string }>>({});
  const [confirm, setConfirm] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const client = useQueryClient();
  const registry = useQuery({
    queryKey: ["worktrees", "registry"],
    queryFn: () => api.git.registry(),
    enabled: open,
    refetchInterval: 15_000,
  });
  const cleanup = useMutation({
    mutationFn: () =>
      api.git.cleanup(
        Object.values(selected).map((item) => {
          const tree = registry.data?.repos
            .flatMap((repo) => repo.worktrees)
            .find((tree) => tree.path === item.path);
          return {
            ...item,
            delete_branch: deleteBranch && Boolean(tree?.merged && tree.branch?.startsWith("orc/")),
          };
        }),
      ),
    onSuccess: () => {
      setSelected({});
      setConfirm(false);
      void client.invalidateQueries({ queryKey: ["worktrees"] });
    },
  });
  function eligible(tree: Worktree): boolean {
    return (
      !tree.main &&
      !tree.dirty &&
      !tree.locked &&
      !tree.active_terminal &&
      Boolean(tree.merged || tree.prunable)
    );
  }
  return (
    <div className="p-3 border-t border-surface-highest space-y-2 text-xs">
      <button
        type="button"
        data-testid="worktree-registry-toggle"
        onClick={() => setOpen(!open)}
        className="text-primary"
      >
        {open ? "Hide worktrees" : "Manage worktrees"}
      </button>
      {open && (
        <div data-testid="worktree-registry" className="space-y-2 max-h-80 overflow-auto">
          <button
            type="button"
            data-testid="worktree-registry-refresh"
            onClick={() => void registry.refetch()}
          >
            Refresh
          </button>
          {registry.isLoading && <p>Loading repositories…</p>}
          {registry.error && <p role="alert">{registry.error.message}</p>}
          {registry.data?.repos.length === 0 && (
            <p>No known repositories. Set a project folder or launch a terminal in a repository.</p>
          )}
          {registry.data?.repos.map((repo) => (
            <div key={repo.root} className="space-y-1">
              <p className="break-all text-outline">{repo.root}</p>
              {repo.worktrees.map((tree) => (
                <label
                  key={tree.path}
                  data-testid="registry-worktree"
                  className="flex gap-2 items-start"
                  title={tree.path}
                >
                  <input
                    type="checkbox"
                    data-testid="registry-worktree-select"
                    disabled={!eligible(tree) || cleanup.isPending}
                    checked={Boolean(selected[tree.path])}
                    onChange={(event) =>
                      setSelected((old) => {
                        const next = { ...old };
                        if (event.target.checked)
                          next[tree.path] = { cwd: repo.root ?? "", path: tree.path };
                        else delete next[tree.path];
                        return next;
                      })
                    }
                  />
                  <span className="break-all">
                    {tree.branch ?? "detached"} {tree.main && "· main"} {tree.merged && "· merged"}{" "}
                    {tree.upstream_gone && "· upstream gone"} {tree.prunable && "· missing"}{" "}
                    {tree.dirty && "· dirty"} {tree.locked && "· locked"}{" "}
                    {tree.active_terminal && `· running: ${tree.active_terminal}`}
                  </span>
                </label>
              ))}
            </div>
          ))}
          {registry.data?.errors.map((error) => (
            <p key={error.cwd} role="alert">
              {error.cwd}: {error.error}
            </p>
          ))}
          <label className="flex gap-2">
            <input
              type="checkbox"
              data-testid="cleanup-delete-branch"
              checked={deleteBranch}
              onChange={(event) => setDeleteBranch(event.target.checked)}
            />
            Also delete merged orc/* branches
          </label>
          <button
            type="button"
            data-testid="worktree-cleanup"
            disabled={!Object.keys(selected).length || cleanup.isPending}
            onClick={() => setConfirm(true)}
            className="text-primary disabled:opacity-40"
          >
            Clean selected ({Object.keys(selected).length})
          </button>
          {cleanup.error && <p role="alert">{cleanup.error.message}</p>}
          {cleanup.data?.results.map((result) => (
            <p
              key={result.path}
              data-testid="cleanup-result"
              role={result.error ? "alert" : undefined}
            >
              {result.path}: {result.removed ? "removed" : result.error}
            </p>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title="Clean selected worktrees?"
        description={`Remove ${Object.keys(selected).length} selected worktree folders. Dirty, locked, active and unmerged worktrees are refused. ${deleteBranch ? "Merged orc/* branches will also be deleted safely." : "Branches are kept."}`}
        confirmLabel="Clean selected"
        isPending={cleanup.isPending}
        onConfirm={() => cleanup.mutate()}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
