import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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

export function GitPanelBody({ terminal, paneId }: { terminal: Terminal; paneId: string }) {
  const { create } = useTerminals();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const [paths, setPaths] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [changeFilter, setChangeFilter] = useState("all");
  const [sideBySide, setSideBySide] = useState(false);
  const status = useQuery({
    queryKey: ["git", terminal.id, "status"],
    queryFn: () => api.git.status(terminal.id),
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
    onSuccess: (created) => {
      const next = new URLSearchParams(params);
      next.set("view", "git");
      next.set("pane", paneId);
      next.set("paneTerminal", created.id);
      next.delete("file");
      next.delete("session");
      navigate({ pathname: `/terminals/${created.id}`, search: next.toString() });
    },
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
  const visibleFiles = (data?.files ?? []).filter((file) => {
    const state = fileChangeState(file);
    return (
      `${file.path} ${file.original ?? ""}`.toLowerCase().includes(filter.toLowerCase()) &&
      (changeFilter === "all" ||
        (changeFilter === "staged" && state.staged) ||
        (changeFilter === "working" && state.working) ||
        (changeFilter === "conflicts" && state.conflict))
    );
  });
  return (
    <div
      data-testid="terminal-git-panel"
      className="flex-1 min-h-0 flex flex-col overflow-hidden text-sm"
    >
      {data?.root && (
        <details
          data-testid="git-checkout-controls"
          className="shrink-0 bg-background border-b border-outline-variant"
        >
          <summary
            data-testid="git-checkout-toggle"
            className="min-h-11 flex items-center gap-2 px-3 text-xs text-on-surface-variant cursor-pointer hover:text-on-surface"
          >
            Checkout &amp; task <span className="ml-auto">Branch, worktree, task link</span>
          </summary>
          <div className="flex flex-wrap items-end gap-3 p-3 pt-0">
            <div className="flex w-full max-w-64 items-end gap-2">
              <label className="flex-1 min-w-0 text-xs text-on-surface-variant">
                Branch
                <select
                  data-testid="git-branch-select"
                  aria-label="Branch"
                  value={data.branch ?? ""}
                  disabled={busy}
                  className="block min-h-11 rounded-md w-full border border-control-border bg-background p-2 text-on-surface"
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
                className="min-h-11 rounded-md p-2 text-primary hover:bg-surface"
                onClick={() => {
                  void status.refetch();
                  void trees.refetch();
                  void github.refetch();
                  void client.invalidateQueries({
                    queryKey: ["git", terminal.id, "diff"],
                  });
                }}
              >
                Refresh
              </button>
            </div>
            <div className="flex min-w-0 flex-1 basis-80 max-w-[32rem] items-end gap-2">
              <label className="block flex-1 min-w-0 text-xs text-on-surface-variant">
                Worktree
                <select
                  data-testid="git-worktree-select"
                  aria-label="Worktree"
                  value={currentTree?.path ?? data.root}
                  disabled={busy}
                  title={currentTree?.path ?? data.root}
                  className="block min-h-11 rounded-md w-full border border-control-border bg-background p-2 text-on-surface"
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
              <button
                type="button"
                data-testid="git-add-worktree"
                disabled={busy}
                onClick={() => action.mutate("worktree")}
                className="shrink-0 min-h-11 rounded-md px-2 text-sm text-primary hover:bg-surface disabled:opacity-40"
              >
                New worktree
              </button>
            </div>
            <TerminalTaskLink terminal={terminal} />
            {trees.error && <p role="alert">{trees.error.message}</p>}
            {openShell.error && <p role="alert">{openShell.error.message}</p>}
            {switchTo.error && <p role="alert">{switchTo.error.message}</p>}
          </div>
        </details>
      )}
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        {action.error && (
          <p role="alert" className="text-error">
            {action.error.message}
          </p>
        )}
        {status.error && <p role="alert">{status.error.message}</p>}
        {data && !data.root && <p>This folder is not a git repository.</p>}
        {data?.root && (
          <>
            <div data-testid="git-current-pr" className="border-b border-outline-variant pb-3">
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
                <span className="text-on-surface-variant">
                  {github.data?.unavailable_reason === "no_remote"
                    ? "This checkout has no GitHub origin remote."
                    : github.data?.unavailable_reason === "detached_head"
                      ? "Detached HEAD: select a branch to find its pull request."
                      : github.data?.auth === "none"
                        ? "GitHub authentication is unavailable on this terminal's host. Authenticate gh there or configure a GitHub token."
                        : github.data?.truncated
                          ? "No matching PR found in the loaded results (results limited)."
                          : "No open PR for this branch."}
                </span>
              )}
            </div>

            <div className="space-y-3">
              <div
                data-testid="git-changes-summary"
                className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-on-surface-variant"
              >
                <span className="font-medium text-on-surface">Changes {data.files.length}</span>
                <span>
                  {data.files.filter((file) => fileChangeState(file).staged).length} staged
                </span>
                <span>
                  {data.files.filter((file) => fileChangeState(file).working).length} unstaged
                </span>
                {conflicts && <span className="text-error">Conflicts need resolution</span>}
              </div>
              {data.files.length === 0 && <p data-testid="git-clean">Working tree clean</p>}
              {data.files.length > 0 && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      data-testid="git-file-filter"
                      aria-label="Filter changed files"
                      placeholder="Filter changed files…"
                      value={filter}
                      onChange={(event) => {
                        setFilter(event.target.value);
                        setPaths([]);
                      }}
                      className="w-64 max-w-full min-w-0 min-h-11 rounded-md border border-control-border bg-background px-3 text-sm"
                    />
                    <select
                      data-testid="git-change-filter"
                      aria-label="Change type"
                      value={changeFilter}
                      onChange={(event) => {
                        setChangeFilter(event.target.value);
                        setPaths([]);
                      }}
                      className="min-h-11 rounded-md border border-control-border bg-background px-2 text-sm"
                    >
                      <option value="all">All changes</option>
                      <option value="staged">Staged</option>
                      <option value="working">Unstaged</option>
                      <option value="conflicts">Conflicts</option>
                    </select>
                    <fieldset className="flex flex-wrap gap-1" aria-label="Diff layout">
                      <button
                        type="button"
                        data-testid="git-layout-unified"
                        aria-pressed={!sideBySide}
                        onClick={() => setSideBySide(false)}
                        className={`min-h-11 sm:min-h-8 rounded px-3 text-xs ${!sideBySide ? "bg-surface-highest" : "text-on-surface-variant hover:bg-surface"}`}
                      >
                        Unified
                      </button>
                      <button
                        type="button"
                        data-testid="git-layout-split"
                        aria-pressed={sideBySide}
                        onClick={() => setSideBySide(true)}
                        className={`min-h-11 sm:min-h-8 rounded px-3 text-xs ${sideBySide ? "bg-surface-highest" : "text-on-surface-variant hover:bg-surface"}`}
                      >
                        Side by side
                      </button>
                    </fieldset>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <label className="flex min-h-11 items-center gap-2 flex-1">
                      <input
                        type="checkbox"
                        data-testid="git-select-all"
                        disabled={visibleFiles.length === 0}
                        checked={
                          visibleFiles.length > 0 &&
                          visibleFiles.every((file) => paths.includes(file.path))
                        }
                        onChange={(event) =>
                          setPaths(
                            event.target.checked
                              ? [
                                  ...new Set(
                                    visibleFiles.flatMap((file) => [
                                      file.path,
                                      ...(file.original ? [file.original] : []),
                                    ]),
                                  ),
                                ]
                              : [],
                          )
                        }
                      />
                      Select all ({visibleFiles.length})
                    </label>
                    <button
                      type="button"
                      data-testid="git-diff-expand-all"
                      onClick={() => setCollapsed([])}
                      className="min-h-11 rounded-md px-2 text-primary hover:bg-surface"
                    >
                      Expand all
                    </button>
                    <button
                      type="button"
                      data-testid="git-diff-collapse-all"
                      onClick={() => setCollapsed(data.files.map((file) => file.path))}
                      className="min-h-11 rounded-md px-2 text-primary hover:bg-surface"
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
                      className="min-h-11 rounded-md px-2 text-primary hover:bg-surface disabled:opacity-40"
                    >
                      Stage selected
                    </button>
                    <input
                      data-testid="git-commit-message"
                      aria-label="Commit message"
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder="Commit message"
                      className="flex-1 basis-80 min-w-0 max-w-full min-h-11 rounded-md border border-control-border bg-background p-2"
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
                      className="min-h-11 rounded-md px-2 text-primary hover:bg-surface disabled:opacity-40"
                    >
                      Commit staged
                    </button>
                  </div>
                  {visibleFiles.length === 0 && (
                    <p
                      data-testid="git-filter-empty"
                      className="py-4 text-sm text-on-surface-variant"
                    >
                      No changed files match this filter.
                    </p>
                  )}
                  {visibleFiles.map((file) => (
                    <FileDiffCard
                      key={file.path}
                      terminalId={terminal.id}
                      sideBySide={sideBySide}
                      openFile={
                        fileChangeState(file).label === "Deleted"
                          ? undefined
                          : (path) =>
                              setParams((current) => {
                                const next = new URLSearchParams(current);
                                next.set("view", "files");
                                next.set("pane", paneId);
                                next.set("paneTerminal", terminal.id);
                                next.set("file", path);
                                return next;
                              })
                      }
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
