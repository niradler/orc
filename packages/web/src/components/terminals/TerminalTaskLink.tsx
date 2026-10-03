import { useQuery } from "@tanstack/react-query";
import { Link2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { api, type Terminal } from "@/api/client";
import { useTasks, useUpdateTask } from "@/hooks/useTasks";

export function TerminalTaskLink({ terminal }: { terminal: Terminal }) {
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !button.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);
  const tasks = useTasks();
  const update = useUpdateTask();
  const status = useQuery({
    queryKey: ["git", terminal.id, "status"],
    queryFn: () => api.git.status(terminal.id),
    enabled: open,
  });
  return (
    <div className="relative shrink-0">
      <button
        ref={button}
        type="button"
        data-testid="terminal-task-link-toggle"
        aria-expanded={open}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect();
          if (rect)
            setPosition({
              left: Math.max(8, Math.min(window.innerWidth - 304, rect.right - 288)),
              top: Math.max(8, Math.min(window.innerHeight - 240, rect.bottom + 8)),
            });
          setOpen(!open);
        }}
        className="inline-flex gap-1 items-center text-xs text-primary"
      >
        <Link2 size={14} />
        Link task
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            style={position}
            data-testid="terminal-task-link-menu"
            className="fixed z-50 w-72 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-16px)] overflow-auto bg-surface border border-surface-highest shadow-xl rounded p-3 space-y-3 text-sm"
          >
            <div className="flex justify-between items-center">
              <strong>Link this terminal checkout</strong>
              <button type="button" aria-label="Close task linking" onClick={() => setOpen(false)}>
                <X size={14} />
              </button>
            </div>
            <select
              data-testid="git-link-task"
              aria-label="Task to link"
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
              className="w-full bg-surface-highest p-2"
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
              data-testid="git-link-save"
              disabled={!taskId || update.isPending || status.isPending || !!status.error}
              onClick={() =>
                update.mutate({
                  id: taskId,
                  git_repo: status.data?.root ?? null,
                  git_branch: status.data?.branch ?? null,
                  git_worktree: status.data?.root ?? terminal.cwd,
                })
              }
              className="text-primary disabled:opacity-40"
            >
              Link checkout
            </button>
            {update.isSuccess && (
              <Link
                data-testid="git-linked-task"
                to={`/tasks/${taskId}`}
                className="block text-primary"
              >
                Open linked task
              </Link>
            )}
            {(update.error || status.error) && (
              <p role="alert">{update.error?.message ?? status.error?.message}</p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
