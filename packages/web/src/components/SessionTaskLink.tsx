import { Link2, Pencil } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { LiveSession, TaskStatus } from "@/api/client";
import { StatusBadge } from "@/components/StatusBadge";
import { TaskPicker } from "@/components/TaskPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useLinkSessionTask } from "@/hooks/useSessions";
import { scopedSessionPath } from "@/lib/live-sessions";

export function SessionTaskLink({
  session,
  linkTestId = "open-task",
}: {
  session: LiveSession;
  linkTestId?: string;
}) {
  const [params] = useSearchParams();
  const [open, setOpen] = useState(false);
  const link = useLinkSessionTask();
  const scope = params.get("project") ?? session.project_id;
  async function select(taskId: string | null): Promise<void> {
    try {
      await link.mutateAsync({ id: session.id, taskId });
      setOpen(false);
    } catch {
      // Mutation error is rendered in the dialog; keep the selection available for retry.
    }
  }

  return (
    <div className="min-w-0 space-y-1">
      {session.task && (
        <div className="min-w-0">
          <Link
            data-testid={linkTestId}
            to={scopedSessionPath(`/tasks/${session.task.id}`, scope)}
            className="block max-w-64 truncate text-sm text-primary hover:underline"
            title={session.task.title}
          >
            {session.task.title}
          </Link>
          <StatusBadge status={session.task.status as TaskStatus} className="px-0" />
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (value) {
            link.reset();
          }
        }}
      >
        <DialogTrigger asChild>
          <button
            type="button"
            data-testid="link-task"
            className="inline-flex min-h-9 items-center gap-1.5 text-xs text-outline hover:text-on-surface"
          >
            {session.task ? <Pencil size={12} /> : <Link2 size={13} />}
            {session.task ? "Change task" : "Link task"}
          </button>
        </DialogTrigger>
        <DialogContent
          data-testid="session-task-dialog"
          className="max-h-[85dvh] w-[calc(100%-2rem)] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>Link a task</DialogTitle>
            <DialogDescription>
              Choose a recent task for {session.name ?? "this session"}, or paste an exact task ID.
            </DialogDescription>
          </DialogHeader>
          {link.error && (
            <p role="alert" className="text-sm text-error">
              {link.error.message}
            </p>
          )}
          <TaskPicker projectId={session.project_id} pending={link.isPending} onSelect={select} />
          <div className="flex flex-wrap gap-2">
            {session.task && (
              <Button
                variant="outline"
                data-testid="session-task-unlink"
                disabled={link.isPending}
                onClick={() => void select(null)}
              >
                Unlink task
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
