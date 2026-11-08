import { useQuery } from "@tanstack/react-query";
import { Link2, X } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Terminal } from "@/api/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTasks, useUpdateTask } from "@/hooks/useTasks";
import { workspaceDestination } from "@/lib/workspace-navigation";
import { TerminalSelect } from "./TerminalSelect";

export function TerminalTaskLink({ terminal }: { terminal: Terminal }) {
  const [params] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState("");
  const tasks = useTasks();
  const update = useUpdateTask();
  const status = useQuery({
    queryKey: ["git", terminal.id, "status"],
    queryFn: () => api.git.status(terminal.id),
    enabled: open,
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="terminal-task-link-toggle"
          aria-label="Link ORC task"
          title="Link ORC task"
          className="git-icon-button"
        >
          <Link2 size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        data-testid="terminal-task-link-menu"
        aria-label="Link ORC task"
        className="w-72 space-y-3 text-sm"
      >
        <div className="flex justify-between items-center">
          <strong>Link this terminal checkout</strong>
          <button
            className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-md hover:bg-surface"
            type="button"
            aria-label="Close task linking"
            onClick={() => setOpen(false)}
          >
            <X size={14} />
          </button>
        </div>
        <TerminalSelect
          data-testid="git-link-task"
          aria-label="Task to link"
          value={taskId}
          onChange={(event) => setTaskId(event.target.value)}
        >
          <option value="">Choose task</option>
          {tasks.data?.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </TerminalSelect>
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
          className="min-h-11 sm:min-h-8 rounded-md text-primary disabled:opacity-40"
        >
          Link checkout
        </button>
        {update.isSuccess && (
          <Link
            data-testid="git-linked-task"
            to={workspaceDestination(
              `/tasks/${taskId}`,
              params.get("project") ?? "all",
              params.toString(),
            )}
            className="block text-primary"
          >
            Open linked task
          </Link>
        )}
        {(update.error || status.error) && (
          <p role="alert">{update.error?.message ?? status.error?.message}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
