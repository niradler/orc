import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Columns2,
  ExternalLink,
  Files,
  GitBranch,
  GitPullRequest,
  List,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
} from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type Terminal } from "@/api/client";
import { fileChangeState } from "@/lib/git-status";
import { useTerminals } from "@/lib/terminals";
import { FileDiffCard } from "./FileDiffCard";
import { PullReviewPanel } from "./PullReviewPanel";
import { TerminalSelect } from "./TerminalSelect";
import { TerminalTaskLink } from "./TerminalTaskLink";
import "./GitPanel.css";

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
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [filesHidden, setFilesHidden] = useState(false);
  const [mobileFilesOpen, setMobileFilesOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const diffRefs = useRef(new Map<string, HTMLDivElement>());
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
    mutationFn: (cwd: string) => create({ kind: "shell", cwd, host: terminal.host }),
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

  const pull = github.data?.items.find(
    (item) =>
      item.kind === "pr" &&
      item.branch === data?.branch &&
      /^https:\/\/github[.]com\//.test(item.url),
  );
  const mode =
    pull && params.get("pr") === String(pull.number) && params.get("pane") === paneId
      ? "pr"
      : "changes";
  const setMode = (nextMode: string) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (nextMode === "pr" && pull) {
        next.set("pr", String(pull.number));
        next.set("pane", paneId);
        next.set("paneTerminal", terminal.id);
        next.set("view", "git");
      } else next.delete("pr");
      return next;
    });
  const reviewAvailable = !!pull && !!github.data && github.data.auth !== "none";
  const stagedCount = data?.files.filter((file) => fileChangeState(file).staged).length ?? 0;
  const groups = [
    { name: "Conflicts", files: visibleFiles.filter((file) => fileChangeState(file).conflict) },
    {
      name: "Staged",
      files: visibleFiles.filter(
        (file) => fileChangeState(file).staged && !fileChangeState(file).conflict,
      ),
    },
    {
      name: "Unstaged",
      files: visibleFiles.filter(
        (file) =>
          fileChangeState(file).working && !fileChangeState(file).conflict && file.index !== "?",
      ),
    },
    { name: "Untracked", files: visibleFiles.filter((file) => file.index === "?") },
  ].filter((group) => group.files.length > 0);
  const togglePath = (path: string, original: string | null | undefined, checked: boolean) =>
    setPaths((old) =>
      checked
        ? [...new Set([...old, path, ...(original ? [original] : [])])]
        : old.filter((item) => item !== path && item !== original),
    );
  const refresh = () => {
    void status.refetch();
    void trees.refetch();
    void github.refetch();
    void client.invalidateQueries({ queryKey: ["git", terminal.id, "diff"] });
  };
  return (
    <div data-testid="terminal-git-panel" className="git-review" data-files-hidden={filesHidden}>
      <div className="git-review-toolbar">
        <button
          type="button"
          data-testid="git-checkout-toggle"
          disabled={!data?.root}
          aria-expanded={checkoutOpen}
          aria-controls={`git-checkout-${paneId}`}
          onClick={() => setCheckoutOpen(!checkoutOpen)}
          title="Branch and worktree"
          className="git-branch-trigger"
        >
          <GitBranch size={14} />
          <span>{data?.branch ?? (data?.root ? "Detached HEAD" : "Git")}</span>
          <ChevronDown size={12} strokeWidth={1.5} className={checkoutOpen ? "rotate-180" : ""} />
        </button>

        <fieldset className="git-mode-tabs" aria-label="Git view">
          <button
            type="button"
            data-testid="git-local-mode"
            aria-label="Local changes"
            aria-pressed={mode !== "pr" || !reviewAvailable}
            onClick={() => setMode("changes")}
          >
            <span className="git-local-label">Local changes</span>
            <span className="git-local-label-short" aria-hidden="true">
              Changes
            </span>
            <span data-testid="git-changes-summary">{data?.files.length ?? 0}</span>
          </button>
          {reviewAvailable && (
            <button
              type="button"
              data-testid="git-pr-mode"
              aria-pressed={mode === "pr"}
              onClick={() => setMode("pr")}
            >
              <GitPullRequest size={13} />
              PR #{pull.number}
            </button>
          )}
          {pull && (
            <a
              data-testid="git-pr-browser"
              href={pull.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open PR in browser"
              aria-label="Open PR in browser"
            >
              <ExternalLink size={13} />
            </a>
          )}
        </fieldset>
        <div className="git-review-toolbar-end">
          <button
            type="button"
            className="git-icon-button git-files-desktop-toggle"
            data-testid="git-files-toggle"
            aria-label={filesHidden ? "Show changed files" : "Hide changed files"}
            aria-expanded={!filesHidden}
            onClick={() => setFilesHidden(!filesHidden)}
          >
            {filesHidden ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
          {data?.root && <TerminalTaskLink terminal={terminal} />}
          <button
            type="button"
            data-testid="git-refresh"
            className="git-icon-button"
            onClick={refresh}
            aria-label="Refresh Git"
            title="Refresh Git"
          >
            <RefreshCw size={14} className={status.isFetching ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      {data?.root && (
        <div
          data-testid="git-checkout-controls"
          id={`git-checkout-${paneId}`}
          hidden={!checkoutOpen}
          className="git-checkout-panel"
        >
          <div className="flex flex-wrap items-end gap-3 p-3 pt-0">
            <div className="flex w-full max-w-64 items-end gap-2">
              <label
                htmlFor={`git-branch-${paneId}`}
                className="flex-1 min-w-0 text-xs text-on-surface-variant"
              >
                Branch
                <TerminalSelect
                  id={`git-branch-${paneId}`}
                  data-testid="git-branch-select"
                  aria-label="Branch"
                  value={data.branch ?? ""}
                  disabled={busy}
                  className=""
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
                </TerminalSelect>
              </label>
            </div>
            <div className="flex min-w-0 flex-1 basis-80 max-w-[32rem] items-end gap-2">
              <label
                htmlFor={`git-worktree-${paneId}`}
                className="block flex-1 min-w-0 text-xs text-on-surface-variant"
              >
                Worktree
                <TerminalSelect
                  id={`git-worktree-${paneId}`}
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
                </TerminalSelect>
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
            {trees.error && <p role="alert">{trees.error.message}</p>}
            {openShell.error && <p role="alert">{openShell.error.message}</p>}
            {switchTo.error && <p role="alert">{switchTo.error.message}</p>}
          </div>

          <div data-testid="git-current-pr" className="border-b border-outline-variant pb-3">
            {github.isPending ? (
              "Checking open pull requests…"
            ) : github.error ? (
              <span role="alert">{github.error.message}</span>
            ) : github.data?.errors.length ? (
              <span role="alert">{github.data.errors.map((error) => error.error).join("; ")}</span>
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
        </div>
      )}
      {(action.error || status.error) && (
        <p role="alert" className="git-review-error">
          {action.error?.message ?? status.error?.message}
        </p>
      )}
      {status.isPending && <p className="git-review-empty">Loading changes…</p>}
      {data && !data.root && (
        <p className="git-review-empty">This folder is not a git repository.</p>
      )}
      {data?.root && (
        <div
          className="git-local-body"
          style={{ display: mode === "pr" && reviewAvailable ? "none" : undefined }}
        >
          <div className="git-review-filters">
            <button
              type="button"
              data-testid="git-files-menu"
              className="git-icon-button git-files-mobile-toggle"
              aria-expanded={mobileFilesOpen}
              aria-label="Show changed files"
              onClick={() => setMobileFilesOpen(!mobileFilesOpen)}
            >
              <Files size={15} />
            </button>
            <label className="git-select-visible" title="Select all displayed changes">
              {" "}
              <input
                type="checkbox"
                data-testid="git-select-all"
                aria-label="Select all displayed changes"
                disabled={visibleFiles.length === 0}
                checked={
                  visibleFiles.length > 0 && visibleFiles.every((file) => paths.includes(file.path))
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
              <span className="sr-only">Select all displayed changes</span>
            </label>
            <div className="git-file-search">
              <Search size={13} aria-hidden="true" />
              <input
                data-testid="git-file-filter"
                aria-label="Filter changed files"
                placeholder="Find a changed file…"
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                  setPaths([]);
                }}
                className="terminal-field"
              />
            </div>
            <div className="git-change-filter">
              <TerminalSelect
                data-testid="git-change-filter"
                aria-label="Change type"
                value={changeFilter}
                onChange={(event) => {
                  setChangeFilter(event.target.value);
                  setPaths([]);
                }}
              >
                <option value="all">All changes</option>
                <option value="staged">Staged</option>
                <option value="working">Unstaged</option>
                <option value="conflicts">Conflicts</option>
              </TerminalSelect>
            </div>
            <fieldset className="git-diff-layout" aria-label="Diff layout">
              <button
                type="button"
                data-testid="git-layout-unified"
                aria-pressed={!sideBySide}
                onClick={() => setSideBySide(false)}
                title="Unified diff"
              >
                <List size={14} />
                <span>Unified</span>
              </button>
              <button
                type="button"
                data-testid="git-layout-split"
                aria-pressed={sideBySide}
                onClick={() => setSideBySide(true)}
                title="Side-by-side diff"
              >
                <Columns2 size={14} />
                <span>Split</span>
              </button>
            </fieldset>
          </div>
          <div className="git-review-body" data-mobile-files-open={mobileFilesOpen}>
            <aside
              data-testid="git-changed-files"
              aria-label="Changed files"
              className="git-change-list"
            >
              <div className="git-list-heading">
                <span>Changes</span>
                <span>{visibleFiles.length}</span>
              </div>
              {groups.map((group) => (
                <section key={group.name}>
                  <h3>
                    {group.name}
                    <span>{group.files.length}</span>
                  </h3>
                  {group.files.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      data-testid="git-change-entry"
                      data-path={file.path}
                      title={file.original ? `${file.original} → ${file.path}` : file.path}
                      aria-current={selectedPath === file.path ? "true" : undefined}
                      onClick={() => {
                        setSelectedPath(file.path);
                        setCollapsed((old) => old.filter((item) => item !== file.path));
                        setMobileFilesOpen(false);
                        requestAnimationFrame(() =>
                          diffRefs.current.get(file.path)?.scrollIntoView({ block: "start" }),
                        );
                      }}
                    >
                      <span className="git-change-name">{file.path.split(/[\\/]/).pop()}</span>
                      <span className="git-change-parent">
                        {file.path.includes("/")
                          ? file.path.slice(0, file.path.lastIndexOf("/"))
                          : ""}
                      </span>
                      <span
                        className={
                          fileChangeState(file).conflict ? "text-error" : "text-on-surface-variant"
                        }
                      >
                        {file.index === "?" ? "U" : fileChangeState(file).label.slice(0, 1)}
                      </span>
                    </button>
                  ))}
                </section>
              ))}
              {visibleFiles.length === 0 && (
                <p className="git-list-empty">
                  {data.files.length ? "No matching files" : "No local changes"}
                </p>
              )}
            </aside>
            <div className="git-diff-scroll" data-testid="git-review-diffs">
              {data.files.length === 0 && (
                <div data-testid="git-clean" className="git-review-empty">
                  <GitBranch size={22} />
                  <p>Working tree clean</p>
                  <span>Local changes will appear here.</span>
                </div>
              )}
              {data.files.length > 0 && visibleFiles.length === 0 && (
                <p data-testid="git-filter-empty" className="git-review-empty">
                  No changed files match this filter.
                </p>
              )}
              {visibleFiles.length > 0 && (
                <div className="git-diff-actions">
                  <span>{stagedCount} staged</span>
                  <button
                    type="button"
                    data-testid="git-diff-expand-all"
                    onClick={() => setCollapsed([])}
                  >
                    Expand all
                  </button>
                  <button
                    type="button"
                    data-testid="git-diff-collapse-all"
                    onClick={() => setCollapsed(data.files.map((file) => file.path))}
                  >
                    Collapse all
                  </button>
                </div>
              )}
              {visibleFiles.map((file) => (
                <div
                  key={file.path}
                  ref={(element) => {
                    if (element) diffRefs.current.set(file.path, element);
                    else diffRefs.current.delete(file.path);
                  }}
                >
                  <FileDiffCard
                    terminalId={terminal.id}
                    sideBySide={sideBySide}
                    file={file}
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
                    open={!collapsed.includes(file.path)}
                    checked={paths.includes(file.path)}
                    select={(checked) => togglePath(file.path, file.original, checked)}
                    toggle={() =>
                      setCollapsed((old) =>
                        old.includes(file.path)
                          ? old.filter((path) => path !== file.path)
                          : [...old, file.path],
                      )
                    }
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="git-commit-bar">
            <button
              type="button"
              data-testid="git-stage"
              disabled={!paths.length || busy}
              onClick={() => action.mutate("stage")}
              className="git-stage-action"
            >
              Stage selected
              {paths.length > 0
                ? ` (${visibleFiles.filter((file) => paths.includes(file.path)).length})`
                : ""}
            </button>
            <div className="git-commit-composer">
              <input
                data-testid="git-commit-message"
                aria-label="Commit message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Commit message…"
                className="terminal-field"
              />
              <button
                type="button"
                data-testid="git-commit"
                disabled={!message.trim() || conflicts || busy || stagedCount === 0}
                onClick={() => action.mutate("commit")}
              >
                Commit{stagedCount > 0 ? ` (${stagedCount})` : ""}
              </button>
            </div>
          </div>
        </div>
      )}
      {reviewAvailable && (
        <PullReviewPanel
          key={`${pull.repo}:${pull.number}`}
          terminalId={terminal.id}
          number={pull.number}
          active={mode === "pr"}
        />
      )}
    </div>
  );
}
