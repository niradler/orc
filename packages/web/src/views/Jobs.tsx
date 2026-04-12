import { Fragment, useState } from "react";
import { Play, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { useJobs, useTriggerJob, useJobRuns } from "@/hooks/useJobs";
import { ViewHeader } from "@/components/ViewHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function Jobs() {
  const { data: jobs, isLoading, error, refetch } = useJobs();
  const triggerJob = useTriggerJob();
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;

  const enabledCount = (jobs ?? []).filter((j) => j.enabled).length;

  return (
    <div>
      <ViewHeader
        title="Jobs"
        meta={`${enabledCount}/${(jobs ?? []).length} enabled`}
        action={
          <Button variant="ghost" size="sm" onClick={() => refetch()}
            className="font-label text-[10px] uppercase tracking-widest text-outline">
            <RefreshCw size={12} className="mr-1" /> Refresh
          </Button>
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full bg-surface-highest" />)}
        </div>
      ) : (jobs ?? []).length === 0 ? (
        <EmptyState message="No jobs configured" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Name</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Type</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">Schedule</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-20">Status</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-16">Runs</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">Last Run</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(jobs ?? []).map((job) => (
                <Fragment key={job.id}>
                  <TableRow
                    className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                    onClick={() => setExpandedJob(expandedJob === job.id ? null : job.id)}
                  >
                    <TableCell>
                      <div className="font-body text-xs font-medium text-on-surface">{job.name}</div>
                      {job.description && (
                        <div className="font-body text-[10px] text-outline mt-0.5">{job.description}</div>
                      )}
                    </TableCell>
                    <TableCell className="font-label text-[10px] text-outline uppercase">{job.trigger_type}</TableCell>
                    <TableCell className="font-label text-[10px] text-outline font-mono">
                      {job.cron_expr ?? "—"}
                    </TableCell>
                    <TableCell>
                      <span className={cn(
                        "font-label text-[10px] font-bold uppercase",
                        job.enabled ? "text-secondary" : "text-outline",
                      )}>
                        {job.enabled ? "● ON" : "○ OFF"}
                      </span>
                    </TableCell>
                    <TableCell className="font-label text-[10px] text-outline">{job.run_count}</TableCell>
                    <TableCell className="font-label text-[10px] text-outline">
                      {job.last_run_at ? new Date(job.last_run_at).toLocaleString() : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="sm"
                          disabled={triggerJob.isPending && triggerJob.variables === job.id}
                          onClick={() => triggerJob.mutate(job.id)}
                          className="font-label text-[10px] uppercase h-7 px-3 bg-secondary/10 text-secondary border border-secondary/30 hover:bg-secondary/20"
                        >
                          <Play size={10} className="mr-1" />
                          {triggerJob.isPending && triggerJob.variables === job.id ? "..." : "Run"}
                        </Button>
                        {expandedJob === job.id ? <ChevronUp size={14} className="text-outline" /> : <ChevronDown size={14} className="text-outline" />}
                      </div>
                    </TableCell>
                  </TableRow>
                  {expandedJob === job.id && (
                    <TableRow key={`${job.id}-runs`} className="border-b border-surface-highest/50 bg-surface-low">
                      <TableCell colSpan={7} className="p-0">
                        <JobRunsExpanded jobId={job.id} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function JobRunsExpanded({ jobId }: { jobId: string }) {
  const { data: runs, isLoading } = useJobRuns(jobId);

  if (isLoading) return (
    <div className="px-6 py-3">
      <Skeleton className="h-6 w-full bg-surface-highest" />
    </div>
  );

  if (!runs?.length) return (
    <div className="px-6 py-3 font-label text-[10px] text-outline uppercase">No runs yet</div>
  );

  return (
    <div className="px-6 py-3 space-y-2">
      <div className="font-label text-[9px] uppercase tracking-widest text-outline mb-2">Recent Runs</div>
      {runs.map((run) => (
        <div key={run.id} className="flex items-center gap-4 font-label text-[10px]">
          <StatusBadge status={run.status} type="job" />
          <span className="text-outline">{run.started_at ? new Date(run.started_at).toLocaleString() : "—"}</span>
          {run.error && <span className="text-error truncate max-w-xs">{run.error}</span>}
        </div>
      ))}
    </div>
  );
}
