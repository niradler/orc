import { ChevronDown, ChevronRight, Play } from "lucide-react";
import { useState } from "react";
import type { JobRun } from "@/api/client";
import { DetailField } from "@/components/DetailField";
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
import { useJob, useJobRunLogs, useJobRuns, useTriggerJob } from "@/hooks/useJobs";

interface JobDetailSheetProps {
  jobId: string | null;
  open: boolean;
  onClose: () => void;
}

export function JobDetailSheet({ jobId, open, onClose }: JobDetailSheetProps) {
  const { data: job } = useJob(jobId);
  const { data: runs, isLoading: runsLoading } = useJobRuns(jobId);
  const triggerJob = useTriggerJob();
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{job?.name ?? "Job Details"}</SheetTitle>
          {job?.description && (
            <p className="font-body text-xs text-outline mt-1">{job.description}</p>
          )}
        </SheetHeader>
        <SheetBody>
          {!job ? (
            <div className="space-y-3">
              {[...Array(6)].map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <Skeleton key={i} className="h-8 w-full bg-surface-highest" />
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              {/* Metadata */}
              <div className="space-y-4">
                <DetailField label="Command">
                  <pre className="font-mono text-xs bg-background p-2 rounded-sm border border-surface-highest overflow-x-auto whitespace-pre-wrap break-all">
                    {job.command}
                  </pre>
                </DetailField>
                <div className="grid grid-cols-2 gap-4">
                  <DetailField label="Trigger Type">
                    <span className="font-label text-[10px] uppercase tracking-wider px-2 py-0.5 bg-surface-highest text-on-surface-variant border border-surface-highest/50 inline-flex">
                      {job.trigger_type}
                    </span>
                  </DetailField>
                  <DetailField label="Enabled">
                    <span
                      className={`font-label text-[10px] font-bold uppercase ${job.enabled ? "text-secondary" : "text-outline"}`}
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
                <div className="grid grid-cols-3 gap-4">
                  <DetailField label="Timeout">{job.timeout_secs}s</DetailField>
                  <DetailField label="Max Retries">{job.max_retries}</DetailField>
                  <DetailField label="Overlap">{job.overlap}</DetailField>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <DetailField label="Notify On">{job.notify_on}</DetailField>
                  <DetailField label="Run Count">{job.run_count}</DetailField>
                </div>
                {job.next_run_at && (
                  <DetailField label="Next Run">
                    {new Date(job.next_run_at).toLocaleString()}
                  </DetailField>
                )}
              </div>

              {/* Recent runs */}
              <div>
                <div className="font-label text-[10px] uppercase tracking-widest text-outline mb-3">
                  Recent Runs
                </div>
                {runsLoading ? (
                  <div className="space-y-2">
                    {[...Array(3)].map((_, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                      <Skeleton key={i} className="h-8 w-full bg-surface-highest" />
                    ))}
                  </div>
                ) : !runs?.length ? (
                  <div className="font-label text-[10px] text-outline uppercase py-4 text-center">
                    No runs yet
                  </div>
                ) : (
                  <div className="space-y-1">
                    {runs.map((run) => (
                      <RunItem
                        key={run.id}
                        run={run}
                        jobId={jobId!}
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
        <SheetFooter>
          {job && (
            <Button
              size="sm"
              disabled={triggerJob.isPending}
              onClick={() => triggerJob.mutate(job.id)}
              className="font-label text-xs uppercase tracking-widest bg-secondary/10 text-secondary border border-secondary/30 hover:bg-secondary/20"
            >
              <Play size={12} className="mr-1.5" />
              {triggerJob.isPending ? "Triggering..." : "Trigger Run"}
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
    <div className="border border-surface-highest rounded-sm overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-surface-low transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown size={12} className="text-outline shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-outline shrink-0" />
        )}
        <StatusBadge status={run.status} type="job" />
        <span className="font-label text-[10px] text-outline flex-1">
          {run.started_at ? new Date(run.started_at).toLocaleString() : "\u2014"}
          {run.ended_at && (
            <span className="ml-2">\u2192 {new Date(run.ended_at).toLocaleString()}</span>
          )}
        </span>
        {run.exit_code !== null && (
          <span
            className={`font-mono text-[10px] ${run.exit_code === 0 ? "text-secondary" : "text-error"}`}
          >
            exit {run.exit_code}
          </span>
        )}
      </button>
      {run.error_msg && (
        <div className="px-3 pb-2">
          <span className="font-body text-[10px] text-error">{run.error_msg}</span>
        </div>
      )}
      {expanded && <RunLogViewer jobId={jobId} runId={run.id} />}
    </div>
  );
}

function RunLogViewer({ jobId, runId }: { jobId: string; runId: string }) {
  const { data: logs, isLoading } = useJobRunLogs(jobId, runId);

  if (isLoading) {
    return (
      <div className="px-3 pb-3">
        <Skeleton className="h-24 w-full bg-surface-highest" />
      </div>
    );
  }

  if (!logs?.length) {
    return (
      <div className="px-3 pb-3 font-label text-[10px] text-outline uppercase">No log output</div>
    );
  }

  return (
    <div className="mx-3 mb-3 rounded-sm overflow-hidden border border-surface-highest">
      <ScrollArea className="h-[240px]">
        <pre className="font-mono text-[11px] leading-relaxed bg-background p-3">
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
