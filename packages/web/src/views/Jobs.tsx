import { Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { CreateJobInput, Job, JobTriggerType, UpdateJobInput } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { JobDetailSheet } from "@/components/JobDetailSheet";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ViewHeader } from "@/components/ViewHeader";
import { useDetailRoute } from "@/hooks/useDetailRoute";
import { useCreateJob, useDeleteJob, useJobs, useTriggerJob, useUpdateJob } from "@/hooks/useJobs";
import { useProjectScope } from "@/hooks/useProjectScope";
import { useProjects } from "@/hooks/useProjects";

const TRIGGER_TYPES: JobTriggerType[] = [
  "one-shot",
  "cron",
  "watch",
  "webhook",
  "manual",
  "bridge-msg",
];

const OVERLAPS: Array<"skip" | "queue" | "kill"> = ["skip", "queue", "kill"];
const NOTIFY_OPTIONS: Array<"never" | "failure" | "always"> = ["never", "failure", "always"];

export default function Jobs({ projectId: savedProjectId }: { projectId: string }) {
  const projectId = useProjectScope(savedProjectId);
  const scopedProjectId = projectId === "all" ? undefined : projectId;
  const { data: jobs, isLoading, error, refetch } = useJobs({ project_id: scopedProjectId });
  const triggerJob = useTriggerJob();
  const deleteJob = useDeleteJob();

  const {
    selectedId: selectedJobId,
    openDetail: openJobDetail,
    closeDetail: closeJobDetail,
  } = useDetailRoute("/jobs", "jobId");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Job | null>(null);
  const [deleting, setDeleting] = useState<Job | null>(null);

  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;

  const enabledCount = (jobs ?? []).filter((j) => j.enabled).length;

  return (
    <div>
      <ViewHeader
        title="Jobs"
        meta={`${enabledCount}/${(jobs ?? []).length} enabled`}
        action={
          <Button
            data-testid="new-job-button"
            size="sm"
            onClick={() => setCreating(true)}
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
          >
            <Plus size={12} className="mr-1" /> New Job
          </Button>
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-12 w-full bg-surface-highest" />
          ))}
        </div>
      ) : (jobs ?? []).length === 0 ? (
        <EmptyState message="No jobs configured" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Name
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Trigger
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-48">
                  Command
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-16">
                  Enabled
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">
                  Last Run
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-16">
                  Runs
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">
                  Next Run
                </TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(jobs ?? []).map((job) => (
                <TableRow
                  key={job.id}
                  data-testid="job-row"
                  data-job-id={job.id}
                  data-job-name={job.name}
                  className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                  onClick={() => openJobDetail(job.id)}
                >
                  <TableCell>
                    <div className="font-body text-xs font-medium text-on-surface">{job.name}</div>
                    {job.description && (
                      <div className="font-body text-[10px] text-outline mt-0.5 truncate max-w-[200px]">
                        {job.description}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="font-label text-[10px] uppercase tracking-wider px-2 py-0.5 bg-surface-highest text-on-surface-variant border border-surface-highest/50 inline-flex">
                      {job.trigger_type}
                    </span>
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-[10px] text-outline truncate block max-w-[180px]">
                      {job.command}
                    </code>
                  </TableCell>
                  <TableCell>
                    <span
                      className={`font-label text-[10px] font-bold uppercase ${job.enabled ? "text-secondary" : "text-error"}`}
                    >
                      {job.enabled ? "\u25CF" : "\u25CF"}
                    </span>
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {job.last_run_at ? new Date(job.last_run_at).toLocaleString() : "\u2014"}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {job.run_count}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {job.next_run_at ? new Date(job.next_run_at).toLocaleString() : "\u2014"}
                  </TableCell>
                  <TableCell>
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: stop propagation wrapper around action buttons */}
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard events bubble to the child buttons */}
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button
                        data-testid="job-trigger"
                        size="sm"
                        disabled={triggerJob.isPending}
                        onClick={() => triggerJob.mutate(job.id)}
                        className="font-label text-[10px] uppercase h-7 px-3 bg-secondary/10 text-secondary border border-secondary/30 hover:bg-secondary/20"
                      >
                        <Play size={10} className="mr-1" /> Run
                      </Button>
                      <button
                        type="button"
                        data-testid="job-delete"
                        onClick={() => setDeleting(job)}
                        className="text-outline hover:text-error transition-colors p-1"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <JobDetailSheet
        jobId={selectedJobId}
        open={Boolean(selectedJobId)}
        onClose={closeJobDetail}
      />

      {creating && (
        <CreateJobDialog
          defaultProjectId={scopedProjectId}
          open={creating}
          onClose={() => setCreating(false)}
        />
      )}

      {editing && (
        <EditJobDialog job={editing} open={Boolean(editing)} onClose={() => setEditing(null)} />
      )}

      {deleting && (
        <ConfirmDialog
          open={Boolean(deleting)}
          title="Delete Job"
          description={`Delete job "${deleting.name}"? This cannot be undone.`}
          confirmLabel="Delete"
          variant="destructive"
          isPending={deleteJob.isPending}
          onConfirm={() => {
            deleteJob.mutate(deleting.id, {
              onSuccess: () => setDeleting(null),
            });
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function CreateJobDialog({
  defaultProjectId,
  open,
  onClose,
}: {
  defaultProjectId?: string;
  open: boolean;
  onClose: () => void;
}) {
  const { data: projects } = useProjects();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [command, setCommand] = useState("");
  const [triggerType, setTriggerType] = useState<JobTriggerType>("manual");
  const [cronExpr, setCronExpr] = useState("");
  const [timeoutSecs, setTimeoutSecs] = useState("300");
  const [maxRetries, setMaxRetries] = useState("0");
  const [overlap, setOverlap] = useState<"skip" | "queue" | "kill">("skip");
  const [notifyOn, setNotifyOn] = useState<"never" | "failure" | "always">("failure");
  const [workingDir, setWorkingDir] = useState("");
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? "");
  const createJob = useCreateJob();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !command.trim()) return;
    const input: CreateJobInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      command: command.trim(),
      trigger_type: triggerType,
      cron_expr: triggerType === "cron" ? cronExpr.trim() || undefined : undefined,
      timeout_secs: Number.parseInt(timeoutSecs, 10) || undefined,
      max_retries: Number.parseInt(maxRetries, 10) || undefined,
      overlap,
      notify_on: notifyOn,
      project_id: projectId || undefined,
      working_dir: workingDir.trim() || undefined,
    };
    createJob.mutate(input, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            New Job
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Name *
            </Label>
            <Input
              data-testid="job-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Job name..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Description
            </Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Command *
            </Label>
            <Textarea
              data-testid="job-command-input"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="bun run build"
              className="bg-background border-surface-highest text-on-surface font-mono text-xs resize-none"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Trigger Type
              </Label>
              <Select
                value={triggerType}
                onValueChange={(v) => setTriggerType(v as JobTriggerType)}
              >
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-body text-xs h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface-highest">
                  {TRIGGER_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="font-body text-xs">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {triggerType === "cron" && (
              <div className="space-y-1.5">
                <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Cron Expression
                </Label>
                <Input
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="*/5 * * * *"
                  className="bg-background border-surface-highest text-on-surface font-mono text-xs"
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Timeout (s)
              </Label>
              <Input
                type="number"
                value={timeoutSecs}
                onChange={(e) => setTimeoutSecs(e.target.value)}
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Max Retries
              </Label>
              <Input
                type="number"
                value={maxRetries}
                onChange={(e) => setMaxRetries(e.target.value)}
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Overlap
              </Label>
              <Select value={overlap} onValueChange={(v) => setOverlap(v as typeof overlap)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-body text-xs h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface-highest">
                  {OVERLAPS.map((o) => (
                    <SelectItem key={o} value={o} className="font-body text-xs">
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Notify On
              </Label>
              <Select value={notifyOn} onValueChange={(v) => setNotifyOn(v as typeof notifyOn)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-body text-xs h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface-highest">
                  {NOTIFY_OPTIONS.map((n) => (
                    <SelectItem key={n} value={n} className="font-body text-xs">
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Working Dir
              </Label>
              <Input
                value={workingDir}
                onChange={(e) => setWorkingDir(e.target.value)}
                placeholder="/path/to/dir"
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Project
            </Label>
            <Select
              value={projectId || "__none__"}
              onValueChange={(v) => setProjectId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger
                data-testid="job-project-select"
                className="bg-background border-surface-highest text-on-surface font-body text-xs h-9"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-surface border-surface-highest">
                <SelectItem value="__none__" className="font-body text-xs">
                  None
                </SelectItem>
                {projects?.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="font-body text-xs">
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="font-label text-xs uppercase text-outline"
            >
              Cancel
            </Button>
            <Button
              data-testid="job-submit"
              type="submit"
              size="sm"
              disabled={createJob.isPending || !name.trim() || !command.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
            >
              {createJob.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditJobDialog({ job, open, onClose }: { job: Job; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(job.name);
  const [description, setDescription] = useState(job.description ?? "");
  const [command, setCommand] = useState(job.command);
  const [triggerType, setTriggerType] = useState<JobTriggerType>(job.trigger_type);
  const [cronExpr, setCronExpr] = useState(job.cron_expr ?? "");
  const [timeoutSecs, setTimeoutSecs] = useState(String(job.timeout_secs));
  const [maxRetries, setMaxRetries] = useState(String(job.max_retries));
  const [overlap, setOverlap] = useState<"skip" | "queue" | "kill">(job.overlap);
  const [notifyOn, setNotifyOn] = useState<"never" | "failure" | "always">(job.notify_on);
  const [enabled, setEnabled] = useState(job.enabled);
  const updateJob = useUpdateJob();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !command.trim()) return;
    const input: UpdateJobInput & { id: string } = {
      id: job.id,
      name: name.trim(),
      description: description.trim() || undefined,
      command: command.trim(),
      trigger_type: triggerType,
      cron_expr: triggerType === "cron" ? cronExpr.trim() || undefined : undefined,
      timeout_secs: Number.parseInt(timeoutSecs, 10) || undefined,
      max_retries: Number.parseInt(maxRetries, 10) || undefined,
      overlap,
      notify_on: notifyOn,
      enabled,
    };
    updateJob.mutate(input, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            Edit Job
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Name *
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Description
            </Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Command *
            </Label>
            <Textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="bg-background border-surface-highest text-on-surface font-mono text-xs resize-none"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Trigger Type
              </Label>
              <Select
                value={triggerType}
                onValueChange={(v) => setTriggerType(v as JobTriggerType)}
              >
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-body text-xs h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface-highest">
                  {TRIGGER_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="font-body text-xs">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {triggerType === "cron" && (
              <div className="space-y-1.5">
                <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Cron Expression
                </Label>
                <Input
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="*/5 * * * *"
                  className="bg-background border-surface-highest text-on-surface font-mono text-xs"
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Timeout (s)
              </Label>
              <Input
                type="number"
                value={timeoutSecs}
                onChange={(e) => setTimeoutSecs(e.target.value)}
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Max Retries
              </Label>
              <Input
                type="number"
                value={maxRetries}
                onChange={(e) => setMaxRetries(e.target.value)}
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Overlap
              </Label>
              <Select value={overlap} onValueChange={(v) => setOverlap(v as typeof overlap)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-body text-xs h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface-highest">
                  {OVERLAPS.map((o) => (
                    <SelectItem key={o} value={o} className="font-body text-xs">
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Notify On
              </Label>
              <Select value={notifyOn} onValueChange={(v) => setNotifyOn(v as typeof notifyOn)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-body text-xs h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-surface-highest">
                  {NOTIFY_OPTIONS.map((n) => (
                    <SelectItem key={n} value={n} className="font-body text-xs">
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Enabled
              </Label>
              <button
                type="button"
                onClick={() => setEnabled(!enabled)}
                className={`w-full h-9 flex items-center justify-center border font-label text-[10px] uppercase tracking-widest transition-colors ${
                  enabled
                    ? "bg-secondary/15 text-secondary border-secondary/30"
                    : "bg-surface-highest text-outline border-surface-highest"
                }`}
              >
                {enabled ? "\u25CF Enabled" : "\u25CB Disabled"}
              </button>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="font-label text-xs uppercase text-outline"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={updateJob.isPending || !name.trim() || !command.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
            >
              {updateJob.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
