import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Terminal } from "@/api/client";
import { fileChangeState } from "@/lib/git-status";
import { useTerminals } from "@/lib/terminals";
import { FileDiffCard } from "./FileDiffCard";
import { TerminalTaskLink } from "./TerminalTaskLink";

function sameCheckout(left: string, right: string | null) {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
  const windows = /^[A-Za-z]:[\\/]/.test(left);
  return windows
    ? normalize(left).toLowerCase() === normalize(right ?? "").toLowerCase()
    : normalize(left) === normalize(right ?? "");
}

export function GitPanelBody({ terminal }: { terminal: Terminal }) {
  const { create } = useTerminals();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [paths, setPaths] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const status = useQuery({
    queryKey: ["git", terminal.id, "status"],
    queryFn: () => api.git.status(terminal.id),
    refetchInterval: 5_000,
  });
  const github = useQuery({
    queryKey: ["git", terminal.id, "github", status.data?.branch],
    queryFn: () => api.git.checkoutGithub(terminal.id),
    enabled: !!status.data?.root,
    staleTime: 60_000,
  });
  const switchTo = useMutation({
    mutationFn: (branch: string) => api.git.switchBranch(terminal.id, branch),
    onSuccess: () => {
      setPaths([]);
      void client.invalidateQueries({ queryKey: ["git", terminal.id] });
      void client.invalidateQueries({ queryKey: ["worktrees"] });
    },
  });
  const trees = useQuery({
    queryKey: ["worktrees", terminal.id],
    queryFn: () => api.git.terminalWorktrees(terminal.id),
    enabled: !!status.data?.root,
    refetchInterval: 10_000,
  });
  const action = useMutation({
    mutationFn: async (kind: "stage" | "commit" | "worktree") => {
      if (kind === "stage") {
        for (let start = 0; start < paths.length; start += 100)
          await api.git.stage(terminal.id, paths.slice(start, start + 100));
        return;
      }
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
  const worktrees =
    trees.data?.worktrees
      .slice()
      .sort(
        (a, b) =>
          Number(sameCheckout(b.path, data?.root ?? null)) -
            Number(sameCheckout(a.path, data?.root ?? null)) ||
          (a.branch ?? a.path).localeCompare(b.branch ?? b.path),
      ) ?? [];
  const currentTree = worktrees.find((tree) => sameCheckout(tree.path, data?.root ?? null));
  const busy = switchTo.isPending || openShell.isPending || action.isPending;
  const conflicts = data?.files.some((file) => fileChangeState(file).conflict);
  return (
    <div
      data-testid="terminal-git-panel"
      className="flex-1 min-h-0 flex flex-col overflow-hidden text-sm"
    >
      {data?.root && (
        <div
          data-testid="git-checkout-controls"
          className="shrink-0 p-3 space-y-2 bg-surface border-b border-surface-highest"
        >
          <div className="flex items-end gap-2">
            <label className="flex-1 min-w-0 text-xs text-outline">
              Branch
              <select
                data-testid="git-branch-select"
                aria-label="Branch"
                value={data.branch ?? ""}
                disabled={busy}
                className="block w-full bg-surface-highest p-2 text-on-surface"
                onChange={(event) => {
                  const tree = worktrees.find(
                    (tree) =>
                      tree.branch === event.target.value && !sameCheckout(tree.path, data.root),
                  );
                  if (tree) openShell.mutate(tree.path);
                  else switchTo.mutate(event.target.value);
                }}
              >
                {!data.branch && <option value="">Detached HEAD · Current</option>}
                {[...data.branches]
                  .sort(
                    (a, b) =>
                      Number(b === data.branch) - Number(a === data.branch) || a.localeCompare(b),
                  )
                  .map((branch) => (
                    <option
                      data-testid="git-branch"
                      key={branch}
                      value={branch}
                      aria-current={branch === data.branch ? "true" : undefined}
                    >
                      {branch}
                      {branch === data.branch ? " · Current" : ""}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              data-testid="git-refresh"
              className="p-2 text-primary"
              onClick={() => {
                void status.refetch();
                void trees.refetch();
                void github.refetch();
                void client.invalidateQueries({ queryKey: ["git", terminal.id, "diff"] });
              }}
            >
              Refresh
            </button>
          </div>
          <label className="block text-xs text-outline">
            Worktree
            <select
              data-testid="git-worktree-select"
              aria-label="Worktree"
              value={currentTree?.path ?? data.root}
              disabled={busy}
              className="block w-full bg-surface-highest p-2 text-on-surface"
              onChange={(event) => {
                if (!sameCheckout(event.target.value, data.root))
                  openShell.mutate(event.target.value);
              }}
            >
              {!currentTree && (
                <option value={data.root}>
                  {data.branch ?? "detached"} · {data.root} · Current
                </option>
              )}
              {worktrees.map((tree) => (
                <option
                  data-testid="git-panel-worktree"
                  key={tree.path}
                  value={tree.path}
                  aria-current={sameCheckout(tree.path, data.root) ? "true" : undefined}
                >
                  {tree.branch ?? "detached"} · {tree.path}
                  {sameCheckout(tree.path, data.root) ? " · Current" : ""}
                  {tree.dirty ? " · dirty" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              data-testid="git-add-worktree"
              disabled={busy}
              onClick={() => action.mutate("worktree")}
              className="text-xs text-primary disabled:opacity-40"
            >
              New orc worktree
            </button>
            <TerminalTaskLink terminal={terminal} />
          </div>
          {trees.error && <p role="alert">{trees.error.message}</p>}
          {action.error && <p role="alert">{action.error.message}</p>}
          {openShell.error && <p role="alert">{openShell.error.message}</p>}
          {switchTo.error && <p role="alert">{switchTo.error.message}</p>}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        {status.error && <p role="alert">{status.error.message}</p>}
        {data && !data.root && <p>This folder is not a git repository.</p>}
        {data?.root && (
          <>
            <div data-testid="git-current-pr" className="rounded border border-surface-highest p-2">
              {github.isPending ? (
                "Checking open pull requests…"
              ) : github.error ? (
                <span role="alert">{github.error.message}</span>
              ) : github.data?.errors.length ? (
                <span role="alert">
                  {github.data.errors.map((error) => error.error).join("; ")}
                </span>
              ) : github.data?.items.filter((item) => item.kind === "pr" && item.state === "open")
                  .length ? (
                github.data.items
                  .filter((item) => item.kind === "pr" && item.state === "open")
                  .map((item) => (
                    <a
                      key={item.url}
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block text-primary"
                    >
                      Open PR #{item.number}: {item.title}
                    </a>
                  ))
              ) : (
                <span className="text-outline">
                  {github.data?.auth === "none"
                    ? "No GitHub connection for this checkout. Authenticate with gh or configure a GitHub token."
                    : github.data?.truncated
                      ? "No matching PR found in the loaded results (results limited)."
                      : "No open PR for this branch."}
                </span>
              )}
            </div>

            <div className="space-y-3">
              {data.files.length === 0 && <p data-testid="git-clean">Working tree clean</p>}
              {data.files.length > 0 && (
                <>
                  <div className="flex items-center gap-3 text-xs">
                    <label className="flex items-center gap-2 flex-1">
                      <input
                        type="checkbox"
                        data-testid="git-select-all"
                        checked={data.files.every((file) => paths.includes(file.path))}
                        onChange={(event) =>
                          setPaths(
                            event.target.checked
                              ? [
                                  ...new Set(
                                    data.files.flatMap((file) => [
                                      file.path,
                                      ...(file.original ? [file.original] : []),
                                    ]),
                                  ),
                                ]
                              : [],
                          )
                        }
                      />
                      Select all ({data.files.length})
                    </label>
                    <button
                      type="button"
                      data-testid="git-diff-expand-all"
                      onClick={() => setCollapsed([])}
                      className="text-primary"
                    >
                      Expand all
                    </button>
                    <button
                      type="button"
                      data-testid="git-diff-collapse-all"
                      onClick={() => setCollapsed(data.files.map((file) => file.path))}
                      className="text-primary"
                    >
                      Collapse all
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <button
                      type="button"
                      data-testid="git-stage"
                      disabled={!paths.length || busy}
                      onClick={() => action.mutate("stage")}
                      className="text-primary disabled:opacity-40"
                    >
                      Stage selected
                    </button>
                    <input
                      data-testid="git-commit-message"
                      aria-label="Commit message"
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder="Commit message"
                      className="flex-1 min-w-0 bg-surface-highest p-2"
                    />
                    <button
                      type="button"
                      data-testid="git-commit"
                      disabled={
                        !message.trim() ||
                        conflicts ||
                        busy ||
                        !data.files.some((file) => file.index !== " " && file.index !== "?")
                      }
                      onClick={() => action.mutate("commit")}
                      className="text-primary disabled:opacity-40"
                    >
                      Commit staged
                    </button>
                  </div>
                  {data.files.map((file) => (
                    <FileDiffCard
                      key={file.path}
                      terminalId={terminal.id}
                      file={file}
                      open={!collapsed.includes(file.path)}
                      checked={paths.includes(file.path)}
                      select={(checked) =>
                        setPaths((old) =>
                          checked
                            ? [
                                ...new Set([
                                  ...old,
                                  file.path,
                                  ...(file.original ? [file.original] : []),
                                ]),
                              ]
                            : old.filter((path) => path !== file.path && path !== file.original),
                        )
                      }
                      toggle={() =>
                        setCollapsed((old) =>
                          old.includes(file.path)
                            ? old.filter((path) => path !== file.path)
                            : [...old, file.path],
                        )
                      }
                    />
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
