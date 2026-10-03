import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Grip, GripHorizontal, X } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Terminal } from "@/api/client";
import { useTasks, useUpdateTask } from "@/hooks/useTasks";
import { useTerminals } from "@/lib/terminals";
import { FileDiffCard } from "./FileDiffCard";

function sameCheckout(left: string, right: string | null) {
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
  const windows = /^[A-Za-z]:[\\/]/.test(left);
  return windows
    ? normalize(left).toLowerCase() === normalize(right ?? "").toLowerCase()
    : normalize(left) === normalize(right ?? "");
}

export function GitPanel({ terminal }: { terminal: Terminal }) {
  const defaults = { width: 640, height: 720 };
  const [size, setSize] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("orc_git_panel_size") ?? "null");
      return stored && Number.isFinite(stored.width) && Number.isFinite(stored.height)
        ? {
            width: Math.max(320, Math.min(1600, stored.width)),
            height: Math.max(240, Math.min(1200, stored.height)),
          }
        : defaults;
    } catch {
      return defaults;
    }
  });
  const saveSize = (width: number, height: number) => {
    const next = { width, height };
    setSize(next);
    try {
      localStorage.setItem("orc_git_panel_size", JSON.stringify(next));
    } catch {}
  };
  const [open, setOpen] = useState(() => sessionStorage.getItem("orc_git_panel_open") === "1");
  const changeOpen = (value: boolean) => {
    sessionStorage.setItem("orc_git_panel_open", value ? "1" : "0");
    setOpen(value);
  };
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; left: number; top: number } | null>(
    null,
  );
  return (
    <aside className="shrink-0 border-l border-surface-highest flex flex-col min-h-0">
      <button
        type="button"
        data-testid="terminal-git-toggle"
        aria-label={open ? "Collapse git panel" : "Expand git panel"}
        aria-expanded={open}
        onClick={() => changeOpen(!open)}
        className="p-3 text-primary"
      >
        <GitBranch size={16} />
      </button>
      {open && (
        <div
          data-testid="git-floating-panel"
          className="fixed z-40 bg-surface border border-surface-highest rounded-lg shadow-2xl flex flex-col overflow-hidden"
          style={{
            left: position?.x,
            top: position?.y ?? 80,
            right: position ? undefined : 16,
            width: `min(${size.width}px, calc(100vw - ${position ? position.x + 8 : 32}px))`,
            height: `min(${size.height}px, calc(100vh - ${(position?.y ?? 80) + 8}px))`,
            minWidth: "min(320px, calc(100vw - 32px))",
            minHeight: 240,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(100vh - 16px)",
          }}
        >
          <div className="flex border-b border-surface-highest">
            <button
              type="button"
              data-testid="git-panel-drag"
              aria-label="Move Git panel; arrow keys move it"
              className="flex-1 flex items-center gap-2 p-3 cursor-move touch-none text-left"
              onPointerDown={(event) => {
                const rect =
                  event.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
                if (!rect) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                setDrag({ x: event.clientX, y: event.clientY, left: rect.left, top: rect.top });
              }}
              onPointerMove={(event) => {
                if (!drag) return;
                const rect =
                  event.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
                setPosition({
                  x: Math.max(
                    8,
                    Math.min(
                      window.innerWidth - (rect?.width ?? 320) - 8,
                      drag.left + event.clientX - drag.x,
                    ),
                  ),
                  y: Math.max(
                    8,
                    Math.min(
                      window.innerHeight - (rect?.height ?? 240) - 8,
                      drag.top + event.clientY - drag.y,
                    ),
                  ),
                });
              }}
              onPointerUp={() => setDrag(null)}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(event) => {
                const delta = {
                  ArrowLeft: [-20, 0],
                  ArrowRight: [20, 0],
                  ArrowUp: [0, -20],
                  ArrowDown: [0, 20],
                }[event.key];
                const rect =
                  event.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
                if (!delta || !rect) return;
                event.preventDefault();
                setPosition({
                  x: Math.max(
                    8,
                    Math.min(window.innerWidth - rect.width - 8, rect.left + delta[0]),
                  ),
                  y: Math.max(
                    8,
                    Math.min(window.innerHeight - rect.height - 8, rect.top + delta[1]),
                  ),
                });
              }}
            >
              <GripHorizontal size={16} />
              Git
            </button>
            <button
              type="button"
              data-testid="git-panel-close"
              aria-label="Close Git panel"
              onClick={() => changeOpen(false)}
              className="p-3"
            >
              <X size={16} />
            </button>
          </div>
          <GitPanelBody key={terminal.id} terminal={terminal} />
          <button
            type="button"
            data-testid="git-panel-resize"
            aria-label="Resize Git panel; arrow keys resize, double-click resets"
            title="Drag to resize, double-click to reset"
            className="absolute bottom-0 right-0 z-10 p-1 cursor-nwse-resize touch-none bg-surface text-outline hover:text-primary focus-visible:text-primary"
            onDoubleClick={() => {
              setPosition(null);
              saveSize(defaults.width, defaults.height);
            }}
            onKeyDown={(event) => {
              const delta = {
                ArrowLeft: [-20, 0],
                ArrowRight: [20, 0],
                ArrowUp: [0, -20],
                ArrowDown: [0, 20],
              }[event.key];
              if (!delta) return;
              event.preventDefault();
              const rect = event.currentTarget.parentElement?.getBoundingClientRect();
              if (rect) {
                setPosition({ x: rect.left, y: rect.top });
                saveSize(
                  Math.max(320, Math.min(window.innerWidth - rect.left - 8, rect.width + delta[0])),
                  Math.max(
                    240,
                    Math.min(window.innerHeight - rect.top - 8, rect.height + delta[1]),
                  ),
                );
              }
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              const handle = event.currentTarget;
              const rect = handle.parentElement?.getBoundingClientRect();
              if (!rect) return;
              setPosition({ x: rect.left, y: rect.top });
              const x = event.clientX;
              const y = event.clientY;
              handle.setPointerCapture(event.pointerId);
              const move = (pointer: PointerEvent) =>
                saveSize(
                  Math.max(
                    320,
                    Math.min(window.innerWidth - rect.left - 8, rect.width + pointer.clientX - x),
                  ),
                  Math.max(
                    240,
                    Math.min(window.innerHeight - rect.top - 8, rect.height + pointer.clientY - y),
                  ),
                );
              const end = () => {
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", end);
                handle.removeEventListener("pointercancel", end);
              };
              handle.addEventListener("pointermove", move);
              handle.addEventListener("pointerup", end);
              handle.addEventListener("pointercancel", end);
            }}
          >
            <Grip size={16} />
          </button>
        </div>
      )}
    </aside>
  );
}

export function GitPanelBody({ terminal }: { terminal: Terminal }) {
  const { create } = useTerminals();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [tab, setTab] = useState("status");
  const [staged, setStaged] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [taskId, setTaskId] = useState("");
  const [diffPath, setDiffPath] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const status = useQuery({
    queryKey: ["git", terminal.id, "status"],
    queryFn: () => api.git.status(terminal.id),
    refetchInterval: 5_000,
  });
  const diffFiles =
    status.data?.files.filter((file) =>
      staged ? file.index !== " " && file.index !== "?" : file.working !== " ",
    ) ?? [];
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
      setDiffPath("");
      void client.invalidateQueries({ queryKey: ["git", terminal.id] });
      void client.invalidateQueries({ queryKey: ["worktrees"] });
    },
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
  return (
    <div
      data-testid="terminal-git-panel"
      className="flex-1 min-h-0 overflow-auto p-4 space-y-3 text-sm"
    >
      <div className="flex justify-between">
        <strong>{data?.branch ?? "Git"}</strong>
        <button
          type="button"
          data-testid="git-refresh"
          onClick={() => {
            void status.refetch();
            void client.invalidateQueries({ queryKey: ["git", terminal.id, "diff"] });
            void github.refetch();
            void trees.refetch();
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
          <div data-testid="git-current-pr" className="rounded border border-surface-highest p-2">
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
              <span className="text-outline">
                {github.data?.auth === "none"
                  ? "No GitHub connection for this checkout. Authenticate with gh or configure a GitHub token."
                  : github.data?.truncated
                    ? "No matching PR found in the loaded results (results limited)."
                    : "No open PR for this branch."}
              </span>
            )}
          </div>
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
              {data.files.length > 0 && (
                <label className="flex items-center gap-2 border-b border-surface-highest pb-2">
                  <input
                    data-testid="git-select-all"
                    type="checkbox"
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
                  Select all changes ({data.files.length})
                </label>
              )}
              {data.files.map((file) => (
                <div key={file.path} data-testid="git-status-file" className="flex gap-2 break-all">
                  <input
                    aria-label={`Select ${file.path}`}
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
                  <button
                    type="button"
                    data-testid="git-file-diff"
                    onClick={() => {
                      setStaged(file.working === " ");
                      setDiffPath(file.path);
                      setCollapsed((old) => old.filter((path) => path !== file.path));
                      setTab("diff");
                    }}
                    className="text-left hover:text-primary"
                  >
                    {file.original ? `${file.original} → ` : ""}
                    {file.path}
                  </button>
                </div>
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
              <div className="flex items-center gap-3 text-xs">
                <span className="text-outline flex-1">{diffFiles.length} changed files</span>
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
                  onClick={() => setCollapsed(diffFiles.map((file) => file.path))}
                  className="text-primary"
                >
                  Collapse all
                </button>
              </div>
              {!diffFiles.length && <p className="text-outline">No changes in this view.</p>}
              {diffFiles.map((file) => (
                <FileDiffCard
                  key={file.path}
                  terminalId={terminal.id}
                  path={file.path}
                  original={file.original}
                  staged={staged}
                  open={!collapsed.includes(file.path)}
                  focused={diffPath === file.path}
                  toggle={() =>
                    setCollapsed((old) =>
                      old.includes(file.path)
                        ? old.filter((path) => path !== file.path)
                        : [...old, file.path],
                    )
                  }
                />
              ))}
            </div>
          )}
          {tab === "branches" && (
            <div className="space-y-2">
              <p>Local branches</p>
              {[...data.branches]
                .sort(
                  (a, b) =>
                    Number(b === data.branch) - Number(a === data.branch) || a.localeCompare(b),
                )
                .map((branch) => (
                  <button
                    type="button"
                    key={branch}
                    data-testid="git-branch"
                    aria-current={branch === data.branch ? "true" : undefined}
                    disabled={branch === data.branch || switchTo.isPending}
                    onClick={() => switchTo.mutate(branch)}
                    className={`block w-full text-left rounded p-2 ${branch === data.branch ? "bg-primary/15 text-primary font-semibold" : "hover:bg-surface-highest"}`}
                  >
                    {branch}
                    {branch === data.branch ? " · Current" : " · Switch"}
                  </button>
                ))}
              <p>Worktrees</p>
              {trees.error && <p role="alert">{trees.error.message}</p>}
              {trees.data?.worktrees
                .slice()
                .sort(
                  (a, b) =>
                    Number(sameCheckout(b.path, data.root)) -
                      Number(sameCheckout(a.path, data.root)) ||
                    (a.branch ?? a.path).localeCompare(b.branch ?? b.path),
                )
                .map((tree) => (
                  <div
                    key={tree.path}
                    data-testid="git-panel-worktree"
                    aria-current={sameCheckout(tree.path, data.root) ? "true" : undefined}
                    className={`break-all rounded p-2 ${sameCheckout(tree.path, data.root) ? "bg-primary/15 text-primary" : "border border-surface-highest"}`}
                  >
                    <strong>{tree.branch ?? "detached"}</strong>
                    <p>{tree.path}</p>
                    {tree.dirty && <span>dirty · </span>}
                    {tree.active_terminal && <span>running · </span>}
                    {sameCheckout(tree.path, data.root) ? (
                      <p>Current checkout</p>
                    ) : (
                      <button
                        data-testid="git-switch-worktree"
                        type="button"
                        disabled={openShell.isPending}
                        onClick={() => openShell.mutate(tree.path)}
                        className="text-primary"
                      >
                        Switch to worktree
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
      {switchTo.error && <p role="alert">{switchTo.error.message}</p>}
    </div>
  );
}
