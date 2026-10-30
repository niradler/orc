import { ChevronDown, ChevronRight, Pencil, Play, Power } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Job, JobRun } from "@/api/client";
import { DetailField } from "@/components/DetailField";
import { ErrorState } from "@/components/ErrorState";
import { JobWebhooks } from "@/components/JobWebhooks";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useJob, useJobRunLogs, useJobRuns, useTriggerJob, useUpdateJob } from "@/hooks/useJobs";

interface JobDetailSheetProps {
  jobId: string | null;
  open: boolean;
  onClose: () => void;
  onEdit?: (job: Job) => void;
  projectScope?: string;
}

export function JobDetailSheet({
  jobId,
  open,
  onClose,
  onEdit,
  projectScope = "all",
}: JobDetailSheetProps) {
  const { data: fetchedJob, isLoading, error, refetch } = useJob(jobId);
  const inScope =
    fetchedJob &&
    (projectScope === "all" ||
      (projectScope === "unassigned"
        ? fetchedJob.project_id === null
        : fetchedJob.project_id === projectScope));
  const job = inScope ? fetchedJob : undefined;
  useEffect(() => {
    if (open && fetchedJob && !inScope) onClose();
  }, [open, fetchedJob, inScope, onClose]);
  const {
    data: runs,
    isLoading: runsLoading,
    error: runsError,
    refetch: refetchRuns,
  } = useJobRuns(job?.id ?? null);
  const triggerJob = useTriggerJob();
  const updateJob = useUpdateJob();
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent data-testid="job-detail-sheet">
        <SheetHeader>
          <SheetTitle>{job?.name ?? "Job details"}</SheetTitle>
          {job?.description && (
            <p className="font-body text-xs text-outline mt-1">{job.description}</p>
          )}
        </SheetHeader>
        <SheetBody>
          {error ? (
            <ErrorState message={error.message} onRetry={() => refetch()} />
          ) : isLoading ? (
            <div className="space-y-3">
              {[...Array(6)].map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <Skeleton key={i} className="h-8 w-full bg-surface-highest" />
              ))}
            </div>
          ) : !job ? (
            <p className="text-sm text-outline">Job not found</p>
          ) : (
            <div className="space-y-6">
              {/* Metadata */}
              <div className="space-y-4">
                <DetailField label="Action">
                  <pre className="font-mono text-xs bg-background p-2 rounded-lg border border-surface-highest overflow-x-auto whitespace-pre-wrap break-all">
                    {job.action?.type === "agent"
                      ? `Run agent (${job.action.backend}): ${job.action.prompt}`
                      : job.action?.type === "task"
                        ? `Create task: ${job.action.title}`
                        : job.command}
                  </pre>
                </DetailField>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <DetailField label="Trigger Type">
                    <span className="font-label text-xs  px-2 py-0.5 bg-surface-highest text-on-surface-variant border border-surface-highest/50 inline-flex">
                      {job.trigger_type}
                    </span>
                  </DetailField>
                  <DetailField label="Enabled">
                    <span
                      className={`font-label text-xs font-bold ${job.enabled ? "text-secondary" : "text-outline"}`}
                    >
                      {job.enabled ? "\u25CF ON" : "\u25CB OFF"}
                    </span>
                  </DetailField>
                </div>
                {job.cron_expr && (
                  <DetailField label="Cron Expression">
                    <code className="font-mono text-xs">{job.cron_expr}</code>
                  </DetailField>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <DetailField label="Timeout">{job.timeout_secs}s</DetailField>
                  <DetailField label="Max Retries">{job.max_retries}</DetailField>
                  <DetailField label="Overlap">{job.overlap}</DetailField>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <DetailField label="Notify On">{job.notify_on}</DetailField>
                  <DetailField label="Run Count">{job.run_count}</DetailField>
                </div>
                {job.next_run_at && (
                  <DetailField label="Next Run">
                    {new Date(job.next_run_at).toLocaleString()}
                  </DetailField>
                )}
              </div>

              {!job.command.startsWith("__") && <JobWebhooks key={job.id} job={job} />}

              {/* Recent runs */}
              <div>
                <div className="font-label text-xs font-medium text-outline mb-3">Recent runs</div>
                {runsError ? (
                  <ErrorState message={runsError.message} onRetry={() => refetchRuns()} />
                ) : runsLoading ? (
                  <div className="space-y-2">
                    {[...Array(3)].map((_, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                      <Skeleton key={i} className="h-8 w-full bg-surface-highest" />
                    ))}
                  </div>
                ) : !runs?.length ? (
                  <div className="font-label text-xs text-outline py-4 text-center">
                    No runs yet
                  </div>
                ) : (
                  <div className="space-y-1">
                    {runs.map((run) => (
                      <RunItem
                        key={run.id}
                        run={run}
                        jobId={jobId as string}
                        expanded={expandedRun === run.id}
                        onToggle={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </SheetBody>
        <SheetFooter className="flex-wrap">
          {(updateJob.error || triggerJob.error) && (
            <p role="alert" className="w-full text-sm text-error">
              {(updateJob.error ?? triggerJob.error)?.message}
            </p>
          )}
          {job && onEdit && (
            <Button
              data-testid="job-detail-edit"
              size="sm"
              variant="outline"
              onClick={() => onEdit(job)}
            >
              <Pencil size={16} />
              Edit job
            </Button>
          )}
          {job && (
            <Button
              size="sm"
              variant="ghost"
              disabled={updateJob.isPending}
              onClick={() => updateJob.mutate({ id: job.id, enabled: !job.enabled })}
              className="font-label text-xs font-medium"
            >
              <Power size={12} className="mr-1.5" />
              {job.enabled ? "Disable" : "Enable"}
            </Button>
          )}
          {job && (
            <Button
              variant="ghost"
              size="sm"
              disabled={triggerJob.isPending}
              onClick={() => triggerJob.mutate(job.id)}
              className="font-label text-xs font-medium bg-transparent text-on-surface border border-control-border hover:bg-surface"
            >
              <Play size={12} className="mr-1.5" />
              {triggerJob.isPending ? "Triggering..." : "Trigger run"}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function RunItem({
  run,
  jobId,
  expanded,
  onToggle,
}: {
  run: JobRun;
  jobId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="min-w-0 border-y border-border overflow-hidden bg-background">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-surface transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-outline shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-outline shrink-0" />
        )}
        <StatusBadge status={run.status} type="job" />
        <span className="font-label text-xs text-outline flex-1">
          {run.started_at ? new Date(run.started_at).toLocaleString() : "\u2014"}
          {run.ended_at && (
            <span className="ml-2">\u2192 {new Date(run.ended_at).toLocaleString()}</span>
          )}
        </span>
        {run.exit_code !== null && (
          <span
            className={`font-mono text-xs ${run.exit_code === 0 ? "text-secondary" : "text-error"}`}
          >
            exit {run.exit_code}
          </span>
        )}
      </button>
      {(run.task_id || run.session_id) && (
        <div className="flex gap-3 px-3 py-2 text-xs">
          {run.task_id && (
            <Link
              className="underline"
              data-testid="job-run-task-link"
              to={`/tasks/${run.task_id}?project=all`}
            >
              Created task
            </Link>
          )}
          {run.session_id && (
            <Link
              className="underline"
              data-testid="job-run-session-link"
              to={`/audit/${run.session_id}?project=all`}
            >
              Agent session
            </Link>
          )}
        </div>
      )}
      {run.error_msg && (
        <div className="px-3 pb-2">
          <span className="font-body text-xs text-error">{run.error_msg}</span>
        </div>
      )}
      {expanded && <RunLogViewer jobId={jobId} runId={run.id} />}
    </div>
  );
}

function RunLogViewer({ jobId, runId }: { jobId: string; runId: string }) {
  const { data: logs, isLoading, error, refetch } = useJobRunLogs(jobId, runId);

  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;

  if (isLoading) {
    return (
      <div className="px-3 pb-3">
        <Skeleton className="h-24 w-full bg-surface-highest" />
      </div>
    );
  }

  if (!logs?.length) {
    return <div className="px-3 pb-3 font-label text-xs text-outline">No log output</div>;
  }

  return (
    <div className="mx-3 mb-3 rounded-lg overflow-hidden border border-surface-highest">
      <ScrollArea className="h-[240px]">
        <pre className="font-mono text-xs leading-relaxed bg-background p-3">
          {logs.map((log) => (
            <div
              key={log.id}
              className={log.stream === "stderr" ? "text-error" : "text-on-surface"}
            >
              {log.line}
            </div>
          ))}
        </pre>
      </ScrollArea>
    </div>
  );
}
