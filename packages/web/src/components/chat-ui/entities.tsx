import type { Job, Task } from "@orc/sdk/types";
import { useQuery } from "@tanstack/react-query";
import { api, type TaskStatus } from "@/api/client";
import { PriorityBadge } from "@/components/PriorityBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { useJob } from "@/hooks/useJobs";
import { useProject } from "@/hooks/useProjects";
import { useScratchpad } from "@/hooks/useScratchpads";
import { useTask } from "@/hooks/useTasks";
import { formatWhen, STATUS as SESSION_STATUS } from "@/lib/live-sessions";
import { scratchpadPath } from "@/lib/scratchpad-routes";
import { cn } from "@/lib/utils";
import { useChatUiAction } from "./actions";
import { ExpandablePanel } from "./ExpandablePanel";
import {
  Dot,
  Empty,
  Failure,
  Loading,
  Meta,
  Panel,
  ProgressBar,
  Rows,
  UiLink,
  when,
} from "./primitives";
import { ScratchpadArtifact } from "./ScratchpadArtifact";

const TASK_STATUSES: TaskStatus[] = [
  "todo",
  "queued",
  "doing",
  "review",
  "changes_requested",
  "blocked",
  "done",
  "paused",
  "cancelled",
];
const DEFAULT_LIMIT = 10;
const titleLink = "text-sm font-medium no-underline hover:underline";
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");

function ProjectName({ id }: { id: string | null }) {
  const { data } = useProject(id);
  if (!id) return null;
  return <UiLink href={`/projects/${id}`}>{data?.name ?? "Project"}</UiLink>;
}

export function TaskCard({ id }: { id: string }) {
  const { data: task, isLoading, error } = useTask(id);
  const { run, pending } = useChatUiAction();
  if (isLoading) return <Loading label="Loading task" />;
  if (error || !task) return <Failure label="Task unavailable." error={error ?? "Not found"} />;
  const busy = pending.has(`task.update:${id}`) || pending.has(`task.delete:${id}`);
  return (
    <ExpandablePanel
      testId="chat-ui-task"
      title={task.title}
      heading={
        <div className="flex min-w-0 items-start justify-between gap-2">
          <UiLink href={`/tasks/${task.id}`} className={cn(titleLink, "break-words")}>
            {task.title}
          </UiLink>
          <PriorityBadge priority={task.priority} className="shrink-0" />
        </div>
      }
      canExpand={Boolean(task.body && (task.body.length > 120 || task.body.split("\n").length > 2))}
    >
      {(expanded) => (
        <div className="flex flex-col gap-2">
          <Meta>
            <StatusBadge status={task.status} className="px-0" />
            <ProjectName id={task.project_id} />
            <span>Updated {formatWhen(task.updated_at)}</span>
          </Meta>
          {task.progress > 0 && <ProgressBar value={task.progress} />}
          {task.body && (
            <p
              className={cn(
                "whitespace-pre-wrap break-words text-on-surface-variant",
                expanded ? "text-base leading-relaxed" : "line-clamp-2 text-xs",
              )}
            >
              {task.body}
            </p>
          )}
          <label className="flex items-center gap-2 text-xs text-on-surface-variant">
            Status
            <select
              data-testid="chat-ui-task-status"
              aria-label="Task status"
              className="form-control form-control-single w-auto min-w-36"
              value={task.status}
              disabled={busy}
              onChange={(event) => run("task.update", { id, status: event.target.value })}
            >
              {TASK_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {label(status)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </ExpandablePanel>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <li className="flex min-w-0 items-center justify-between gap-3 py-2">
      <UiLink
        href={`/tasks/${task.id}`}
        className="min-w-0 truncate text-sm no-underline hover:underline"
      >
        <span className="truncate">{task.title}</span>
      </UiLink>
      <StatusBadge status={task.status} className="shrink-0 px-0" />
    </li>
  );
}

export function TaskList({
  projectId,
  status,
  limit = DEFAULT_LIMIT,
}: {
  projectId?: string;
  status?: string;
  limit?: number;
}) {
  const params = { project_id: projectId, status, limit };
  const { data, isLoading, error } = useQuery({
    queryKey: ["tasks", "chat-ui", params],
    queryFn: () => api.tasks.list(params),
  });
  if (isLoading) return <Loading label="Loading tasks" />;
  if (error || !data) return <Failure label="Tasks unavailable." error={error} />;
  return (
    <Panel testId="chat-ui-task-list">
      {data.tasks.length ? (
        <Rows>
          {data.tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </Rows>
      ) : (
        <Empty>No matching tasks.</Empty>
      )}
      {data.total > data.tasks.length && (
        <p className="pt-1 text-xs text-on-surface-variant">
          {data.tasks.length} of {data.total} ·{" "}
          <UiLink href={projectId ? `/projects/${projectId}` : "/tasks"}>View all</UiLink>
        </p>
      )}
    </Panel>
  );
}

function schedule(job: Job): string {
  return job.trigger_type === "cron" && job.cron_expr ? job.cron_expr : label(job.trigger_type);
}

export function JobCard({ id }: { id: string }) {
  const { data: job, isLoading, error } = useJob(id);
  const { run, pending } = useChatUiAction();
  if (isLoading) return <Loading label="Loading job" />;
  if (error || !job) return <Failure label="Job unavailable." error={error ?? "Not found"} />;
  return (
    <Panel testId="chat-ui-job" className="flex flex-col gap-2">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <UiLink href={`/jobs/${job.id}`} className={cn(titleLink, "break-words")}>
          {job.name}
        </UiLink>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-on-surface-variant">
          <Dot tone={job.enabled ? "success" : "neutral"} />
          {job.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>
      {job.description && <p className="text-xs text-on-surface-variant">{job.description}</p>}
      <Meta>
        <span className="font-mono">{schedule(job)}</span>
        <span>Last {when(job.last_run_at)}</span>
        {job.enabled && job.next_run_at && <span>Next {when(job.next_run_at)}</span>}
        <span>{job.run_count} runs</span>
        <ProjectName id={job.project_id} />
      </Meta>
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="chat-ui-job-run"
          size="sm"
          variant="outline"
          disabled={pending.has(`job.run:${id}`)}
          onClick={() => run("job.run", { id })}
        >
          Run now
        </Button>
        <Button
          data-testid="chat-ui-job-toggle"
          size="sm"
          variant="ghost"
          disabled={pending.has(`job.setEnabled:${id}`)}
          onClick={() => run("job.setEnabled", { id, enabled: !job.enabled })}
        >
          {job.enabled ? "Disable" : "Enable"}
        </Button>
      </div>
    </Panel>
  );
}

export function SessionList({
  projectId,
  limit = DEFAULT_LIMIT,
}: {
  projectId?: string;
  limit?: number;
}) {
  const params = { project_id: projectId, limit };
  const { data, isLoading, error } = useQuery({
    queryKey: ["sessions", "live", "chat-ui", params],
    queryFn: () => api.sessions.live(params),
  });
  if (isLoading) return <Loading label="Loading sessions" />;
  if (error || !data) return <Failure label="Sessions unavailable." error={error} />;
  const canExpand =
    data.sessions.length > 3 ||
    data.sessions.some((session) => (session.summary?.length ?? 0) > 100);
  return (
    <ExpandablePanel testId="chat-ui-session-list" title="Sessions" canExpand={canExpand}>
      {(expanded) => (
        <>
          {data.sessions.length ? (
            <Rows>
              {(expanded ? data.sessions : data.sessions.slice(0, 3)).map((session) => {
                const status = SESSION_STATUS[session.status];
                return (
                  <li key={session.id} className="flex min-w-0 flex-col gap-1 py-2">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <UiLink
                        href={`/sessions?session=${encodeURIComponent(session.id)}`}
                        className="min-w-0 text-sm no-underline hover:underline"
                      >
                        <span className={expanded ? "break-words" : "truncate"}>
                          {session.name ?? session.agent}
                        </span>
                      </UiLink>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs text-on-surface-variant">
                        <span
                          aria-hidden="true"
                          className={cn("size-1.5 rounded-full", status.dot)}
                        />
                        {status.label}
                      </span>
                    </div>
                    {session.summary && (
                      <p
                        className={cn(
                          "whitespace-pre-wrap break-words text-on-surface-variant",
                          expanded ? "text-sm leading-relaxed" : "line-clamp-2 text-xs",
                        )}
                      >
                        {session.summary}
                      </p>
                    )}
                    <Meta>
                      <span>{session.agent}</span>
                      <span>{formatWhen(session.last_activity_at)}</span>
                      {session.task && (
                        <UiLink href={`/tasks/${session.task.id}`}>{session.task.title}</UiLink>
                      )}
                    </Meta>
                  </li>
                );
              })}
            </Rows>
          ) : (
            <Empty>No sessions yet.</Empty>
          )}
          {!expanded && data.sessions.length > 3 && (
            <p className="text-xs text-muted-foreground">
              3 of {data.sessions.length} loaded sessions
            </p>
          )}
        </>
      )}
    </ExpandablePanel>
  );
}

function hasLongContent(content: string): boolean {
  return content.length > 240 || content.split("\n").length > 4;
}

export function ScratchpadCard({ id }: { id: string }) {
  const { data: pad, isLoading, error } = useScratchpad(id);
  if (isLoading) return <Loading label="Loading scratchpad" />;
  if (error || !pad)
    return <Failure label="Scratchpad unavailable." error={error ?? "Not found"} />;
  return (
    <ExpandablePanel
      testId="chat-ui-scratchpad"
      title={pad.title}
      heading={
        <UiLink href={scratchpadPath(pad.id)} className={cn(titleLink, "break-words")}>
          {pad.title}
        </UiLink>
      }
      canExpand={pad.kind !== "doc" || hasLongContent(pad.content)}
    >
      {(expanded) => (
        <div className="space-y-1.5">
          <div data-testid="chat-ui-scratchpad-content">
            <ScratchpadArtifact pad={pad} expanded={expanded} />
          </div>
          <Meta>
            <span>{label(pad.kind)}</span>
            {pad.tags.map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
            <span>Updated {when(pad.updated_at)}</span>
          </Meta>
        </div>
      )}
    </ExpandablePanel>
  );
}
