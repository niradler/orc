import type { JobAction, WebhookSubscription } from "@orc/core/job-actions";
import { Pencil, Play, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import type { CreateJobInput, Job, JobTriggerType, UpdateJobInput } from "@/api/client";
import { BulkActionBar } from "@/components/BulkActionBar";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { JobActionFields, jobActionValid } from "@/components/JobActionFields";
import { JobDetailSheet } from "@/components/JobDetailSheet";
import { WebhookPicker } from "@/components/JobWebhooks";
import { ResponsiveFilters } from "@/components/ResponsiveFilters";
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
import { ViewHeader } from "@/components/ViewHeader";
import { useDetailRoute } from "@/hooks/useDetailRoute";
import {
  useCreateJob,
  useDeleteJob,
  useJobs,
  useSetJobsEnabled,
  useTriggerJob,
  useUpdateJob,
} from "@/hooks/useJobs";
import { useListSelection } from "@/hooks/useListSelection";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { useProjectScope } from "@/hooks/useProjectScope";
import { useProjects } from "@/hooks/useProjects";
import { useViewParam } from "@/lib/view-params";

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
  const desktop = useBreakpoint("xl");
  const [query, setQuery] = useViewParam<string>("jobQuery", "");
  const [status, setStatus] = useViewParam<string>("jobStatus", "all", [
    "all",
    "enabled",
    "disabled",
  ]);
  const [trigger, setTrigger] = useViewParam<string>("jobTrigger", "all", [
    "all",
    ...TRIGGER_TYPES,
  ]);
  const projectId = useProjectScope(savedProjectId);
  const scopedProjectId = projectId === "all" || projectId === "unassigned" ? undefined : projectId;
  const {
    data: allJobs,
    isLoading,
    error,
    refetch,
  } = useJobs({ project_id: scopedProjectId, limit: 100 });
  const scopedJobs =
    projectId === "unassigned" ? allJobs?.filter((job) => job.project_id === null) : allJobs;
  const jobs = scopedJobs?.filter(
    (job) =>
      (!query ||
        `${job.name} ${job.description ?? ""} ${job.command ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (status === "all" || job.enabled === (status === "enabled")) &&
      (trigger === "all" || job.trigger_type === trigger),
  );
  const listScope = JSON.stringify([projectId, query, status, trigger]);
  const triggerJob = useTriggerJob();
  const deleteJob = useDeleteJob();
  const updateJob = useUpdateJob();
  const bulkUpdate = useSetJobsEnabled();
  const bulkResult = bulkUpdate.data?.scope === listScope ? bulkUpdate.data : undefined;

  const selection = useListSelection(
    (jobs ?? []).map((job) => job.id),
    listScope,
  );
  async function setSelectedEnabled(enabled: boolean): Promise<void> {
    const result = await bulkUpdate.mutateAsync({
      ids: selection.selectedIds,
      enabled,
      scope: listScope,
    });
    selection.select(result.failed.map((item) => item.id));
  }

  const {
    selectedId: selectedJobId,
    openDetail: openJobDetail,
    closeDetail: closeJobDetail,
  } = useDetailRoute("/jobs", "jobId");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Job | null>(null);
  const [deleting, setDeleting] = useState<Job | null>(null);

  if (error)
    return (
      <div>
        <ViewHeader title="Jobs" />
        <ErrorState message={error.message} onRetry={() => refetch()} />
      </div>
    );

  const enabledCount = (jobs ?? []).filter((j) => j.enabled).length;

  return (
    <div>
      <ViewHeader
        title="Jobs"
        compact
        meta={`${enabledCount}/${(jobs ?? []).length} enabled`}
        action={
          <Button
            data-testid="new-job-button"
            size="sm"
            onClick={() => setCreating(true)}
            className="font-label text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={12} className="mr-1" /> New job
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 lg:max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
          <Input
            type="search"
            aria-label="Search jobs"
            data-testid="job-search"
            placeholder="Search jobs…"
            value={query}
            onChange={(event) => setQuery(event.target.value, { replace: true })}
            className="h-11 pl-9 text-base lg:h-9 lg:text-sm"
          />
        </div>
        <ResponsiveFilters activeCount={Number(status !== "all") + Number(trigger !== "all")}>
          <select
            aria-label="Job status"
            data-testid="job-status-filter"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="form-control form-control-single max-w-full"
          >
            <option value="all">All statuses</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
          <select
            aria-label="Job trigger"
            data-testid="job-trigger-filter"
            value={trigger}
            onChange={(event) => setTrigger(event.target.value)}
            className="form-control form-control-single max-w-full"
          >
            <option value="all">All triggers</option>
            {TRIGGER_TYPES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </ResponsiveFilters>
      </div>

      {(triggerJob.error || deleteJob.error || updateJob.error) && (
        <p role="alert" className="mb-4 text-sm text-error">
          {(triggerJob.error ?? deleteJob.error ?? updateJob.error)?.message}
        </p>
      )}

      {!!jobs?.length && (
        <BulkActionBar
          resourceLabel="jobs"
          count={selection.selectedIds.length}
          allSelected={selection.allSelected}
          someSelected={selection.someSelected}
          onSelectAll={selection.selectAll}
          onClear={selection.clear}
          disabled={bulkUpdate.isPending}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="jobs-bulk-enable"
            disabled={bulkUpdate.isPending || updateJob.isPending}
            onClick={() => void setSelectedEnabled(true)}
          >
            Enable selected
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="jobs-bulk-disable"
            disabled={bulkUpdate.isPending || updateJob.isPending}
            onClick={() => void setSelectedEnabled(false)}
          >
            Disable selected
          </Button>
        </BulkActionBar>
      )}
      {bulkUpdate.isPending && (
        <p role="status" className="mb-3 text-sm text-outline">
          Updating selected jobs…
        </p>
      )}
      {!bulkUpdate.isPending && bulkResult && (
        <div className="mb-3 space-y-1 text-sm" data-testid="jobs-bulk-result" role="status">
          <p>
            {bulkResult.succeeded.length} jobs {bulkResult.enabled ? "enabled" : "disabled"}.
          </p>
          {bulkResult.failed.map((item) => (
            <p key={item.id} className="text-error">
              {jobs?.find((job) => job.id === item.id)?.name ?? item.id}: {item.error}. Still
              selected for retry.
            </p>
          ))}
        </div>
      )}

      {isLoading ? (
        <div role="status" aria-label="Loading jobs" className="space-y-2">
          {[...Array(3)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-12 w-full bg-surface-highest" />
          ))}
        </div>
      ) : (jobs ?? []).length === 0 ? (
        <EmptyState
          message={
            query || status !== "all" || trigger !== "all" ? "No jobs match" : "No jobs configured"
          }
        />
      ) : !desktop ? (
        <div className="divide-y divide-border">
          {(jobs ?? []).map((job) => (
            <article
              key={job.id}
              data-testid="job-row"
              data-job-id={job.id}
              data-job-name={job.name}
              className="py-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-3">
                <input
                  type="checkbox"
                  className="size-4 accent-primary shrink-0 mt-1"
                  aria-label={`Select ${job.name}`}
                  data-testid="job-select"
                  checked={selection.selectedIds.includes(job.id)}
                  disabled={bulkUpdate.isPending}
                  onChange={() => selection.toggle(job.id)}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left font-medium text-sm text-on-surface wrap-break-word hover:text-primary"
                  data-testid="job-open-detail"
                  onClick={() => openJobDetail(job.id)}
                >
                  {job.name}
                </button>
                <Button
                  type="button"
                  data-testid="job-toggle-enabled"
                  variant="outline"
                  size="sm"
                  aria-label={`${job.enabled ? "Disable" : "Enable"} ${job.name}`}
                  aria-pressed={job.enabled}
                  disabled={updateJob.isPending || bulkUpdate.isPending}
                  onClick={() => updateJob.mutate({ id: job.id, enabled: !job.enabled })}
                >
                  {job.enabled ? "Disable" : "Enable"}
                </Button>
              </div>
              {job.description && (
                <p className="text-sm text-outline wrap-break-word">{job.description}</p>
              )}
              <code className="block whitespace-pre-wrap break-all text-xs text-on-surface-variant">
                {job.action?.type === "agent"
                  ? `Agent: ${job.action.backend}`
                  : job.action?.type === "task"
                    ? `Task: ${job.action.title}`
                    : job.command}
              </code>
              <p className="text-xs text-outline">
                {job.trigger_type} · {job.run_count} runs
                {job.next_run_at ? ` · Next: ${new Date(job.next_run_at).toLocaleString()}` : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  data-testid="job-edit"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing(job)}
                >
                  <Pencil />
                  Edit
                </Button>
                <Button
                  data-testid="job-trigger"
                  variant="ghost"
                  size="sm"
                  disabled={triggerJob.isPending}
                  onClick={() => triggerJob.mutate(job.id)}
                >
                  <Play />
                  Run
                </Button>
                <Button
                  data-testid="job-delete"
                  aria-label={`Delete ${job.name}`}
                  variant="ghost"
                  size="icon"
                  onClick={() => setDeleting(job)}
                >
                  <Trash2 />
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="min-w-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-border hover:bg-transparent">
                <TableHead className="w-11">
                  <span className="sr-only">Select jobs</span>
                </TableHead>
                <TableHead className="font-label text-xs font-medium text-outline">Name</TableHead>
                <TableHead className="font-label text-xs font-medium text-outline w-24">
                  Trigger
                </TableHead>
                <TableHead className="font-label text-xs font-medium text-outline w-48">
                  Action
                </TableHead>
                <TableHead className="font-label text-xs font-medium text-outline w-16">
                  Enabled
                </TableHead>
                <TableHead className="font-label text-xs font-medium text-outline w-36">
                  Last Run
                </TableHead>
                <TableHead className="font-label text-xs font-medium text-outline w-16">
                  Runs
                </TableHead>
                <TableHead className="font-label text-xs font-medium text-outline w-36">
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
                  className="border-b border-border/65 hover:bg-surface-high cursor-pointer"
                  onClick={() => openJobDetail(job.id)}
                >
                  <TableCell>
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      aria-label={`Select ${job.name}`}
                      data-testid="job-select"
                      checked={selection.selectedIds.includes(job.id)}
                      disabled={bulkUpdate.isPending}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => selection.toggle(job.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="font-body text-sm font-medium text-on-surface text-left hover:text-primary"
                      data-testid="job-open-detail"
                      onClick={(event) => {
                        event.stopPropagation();
                        openJobDetail(job.id);
                      }}
                    >
                      {job.name}
                    </button>
                    {job.description && (
                      <div className="font-body text-sm text-outline mt-0.5 truncate max-w-[200px]">
                        {job.description}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="font-label text-xs text-on-surface-variant inline-flex">
                      {job.trigger_type}
                    </span>
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs text-outline truncate block max-w-[180px]">
                      {job.action?.type === "agent"
                        ? `Agent: ${job.action.backend}`
                        : job.action?.type === "task"
                          ? `Task: ${job.action.title}`
                          : job.command}
                    </code>
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      data-testid="job-toggle-enabled"
                      variant="outline"
                      size="sm"
                      aria-label={`${job.enabled ? "Disable" : "Enable"} ${job.name}`}
                      aria-pressed={job.enabled}
                      disabled={updateJob.isPending || bulkUpdate.isPending}
                      onClick={(event) => {
                        event.stopPropagation();
                        updateJob.mutate({ id: job.id, enabled: !job.enabled });
                      }}
                    >
                      {job.enabled ? "Disable" : "Enable"}
                    </Button>
                  </TableCell>
                  <TableCell className="font-label text-xs text-outline">
                    {job.last_run_at ? new Date(job.last_run_at).toLocaleString() : "\u2014"}
                  </TableCell>
                  <TableCell className="font-label text-xs text-outline">{job.run_count}</TableCell>
                  <TableCell className="font-label text-xs text-outline">
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
                        className="font-label text-sm min-h-11 px-3 bg-transparent text-on-surface border border-border hover:bg-surface-high"
                      >
                        <Play size={10} className="mr-1" /> Run
                      </Button>
                      <button
                        type="button"
                        data-testid="job-edit"
                        aria-label={`Edit ${job.name}`}
                        onClick={() => setEditing(job)}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-outline hover:text-primary hover:bg-surface-highest"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        data-testid="job-delete"
                        aria-label={`Delete ${job.name}`}
                        onClick={() => setDeleting(job)}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-outline hover:text-error hover:bg-error/10"
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
        onEdit={(job) => {
          closeJobDetail();
          setEditing(job);
        }}
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
  const [action, setAction] = useState<JobAction>({ type: "command", command: "" });
  const [bindings, setBindings] = useState<WebhookSubscription[]>([]);
  const [triggerType, setTriggerType] = useState<JobTriggerType>("manual");
  const [cronExpr, setCronExpr] = useState("");
  const [timeoutSecs, setTimeoutSecs] = useState("300");
  const [maxRetries, setMaxRetries] = useState("0");
  const [overlap, setOverlap] = useState<"skip" | "queue" | "kill">("skip");
  const [notifyOn, setNotifyOn] = useState<"never" | "failure" | "always">("failure");
  const [workingDir, setWorkingDir] = useState("");
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? "");
  const createJob = useCreateJob();
  const [enabled, setEnabled] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !jobActionValid(action) || (triggerType === "webhook" && !bindings.length))
      return;
    const input: CreateJobInput = {
      name: name.trim(),
      description: description.trim(),
      action,
      webhooks: triggerType === "webhook" ? bindings : [],
      trigger_type: triggerType,
      enabled,
      cron_expr: triggerType === "cron" ? cronExpr.trim() || undefined : undefined,
      timeout_secs: Number.parseInt(timeoutSecs, 10) || undefined,
      max_retries: Number.parseInt(maxRetries, 10),
      overlap,
      notify_on: notifyOn,
      project_id: projectId || undefined,
      working_dir: workingDir.trim() || undefined,
    };
    createJob.mutate(input, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-border max-w-lg max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm font-medium text-on-surface">
            New job
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 mt-2">
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input
              type="checkbox"
              data-testid="job-create-enabled"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="size-4 accent-primary"
            />
            Enable this job immediately
          </label>
          <p className="text-xs text-outline">
            New jobs stay disabled until you enable them. You can configure their webhook first.
          </p>
          <div className="space-y-1.5">
            <Label className="font-label text-xs font-medium text-outline">Name *</Label>
            <Input
              aria-label="Name"
              data-testid="job-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Job name..."
              className="bg-background border-control-border text-on-surface font-body text-sm"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-xs font-medium text-outline">Description</Label>
            <Input
              aria-label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description..."
              className="bg-background border-control-border text-on-surface font-body text-sm"
            />
          </div>
          <JobActionFields value={action} onChange={setAction} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Trigger Type</Label>
              <Select
                value={triggerType}
                onValueChange={(v) => setTriggerType(v as JobTriggerType)}
              >
                <SelectTrigger
                  aria-label="Trigger type"
                  data-testid="job-trigger-type"
                  className="bg-background border-control-border text-on-surface font-body text-sm min-h-11"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-border">
                  {TRIGGER_TYPES.map((t) => (
                    <SelectItem
                      key={t}
                      value={t}
                      data-testid={`job-trigger-${t}`}
                      className="font-body text-sm"
                    >
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {triggerType === "webhook" && (
              <div className="sm:col-span-2">
                <WebhookPicker
                  value={bindings}
                  onChange={setBindings}
                  projectId={projectId || undefined}
                />
              </div>
            )}
            {triggerType === "cron" && (
              <div className="space-y-1.5">
                <Label className="font-label text-xs font-medium text-outline">
                  Cron Expression
                </Label>
                <Input
                  aria-label="Cron expression"
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="*/5 * * * *"
                  className="bg-background border-control-border text-on-surface font-mono text-xs"
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Timeout (s)</Label>
              <Input
                aria-label="Timeout in seconds"
                type="number"
                min={1}
                required
                value={timeoutSecs}
                onChange={(e) => setTimeoutSecs(e.target.value)}
                className="bg-background border-control-border text-on-surface font-body text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Max Retries</Label>
              <Input
                aria-label="Maximum retries"
                type="number"
                min={0}
                required
                value={maxRetries}
                onChange={(e) => setMaxRetries(e.target.value)}
                className="bg-background border-control-border text-on-surface font-body text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Overlap</Label>
              <Select value={overlap} onValueChange={(v) => setOverlap(v as typeof overlap)}>
                <SelectTrigger
                  aria-label="Overlap"
                  className="bg-background border-control-border text-on-surface font-body text-sm min-h-11"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-border">
                  {OVERLAPS.map((o) => (
                    <SelectItem key={o} value={o} className="font-body text-sm">
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Notify On</Label>
              <Select value={notifyOn} onValueChange={(v) => setNotifyOn(v as typeof notifyOn)}>
                <SelectTrigger
                  aria-label="Notify on"
                  className="bg-background border-control-border text-on-surface font-body text-sm min-h-11"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-border">
                  {NOTIFY_OPTIONS.map((n) => (
                    <SelectItem key={n} value={n} className="font-body text-sm">
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Working Dir</Label>
              <Input
                aria-label="Working directory"
                value={workingDir}
                onChange={(e) => setWorkingDir(e.target.value)}
                placeholder="/path/to/dir"
                className="bg-background border-control-border text-on-surface font-body text-sm"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-xs font-medium text-outline">Project</Label>
            <Select
              value={projectId || "__none__"}
              onValueChange={(v) => {
                setProjectId(v === "__none__" ? "" : v);
                setBindings([]);
              }}
            >
              <SelectTrigger
                aria-label="Project"
                data-testid="job-project-select"
                className="bg-background border-control-border text-on-surface font-body text-sm min-h-11"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-surface border-border">
                <SelectItem value="__none__" className="font-body text-sm">
                  None
                </SelectItem>
                {projects?.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="font-body text-sm">
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
              className="font-label text-xs text-outline"
            >
              Cancel
            </Button>
            <Button
              data-testid="job-submit"
              type="submit"
              size="sm"
              disabled={
                createJob.isPending ||
                !name.trim() ||
                !jobActionValid(action) ||
                (triggerType === "webhook" && !bindings.length)
              }
              className="font-label text-xs bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {createJob.isPending
                ? "Creating..."
                : triggerType === "webhook"
                  ? "Create job"
                  : "Create"}
            </Button>
          </DialogFooter>
          {createJob.error && (
            <p role="alert" className="text-sm text-error">
              {createJob.error.message}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditJobDialog({ job, open, onClose }: { job: Job; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(job.name);
  const [description, setDescription] = useState(job.description ?? "");
  const [action, setAction] = useState<JobAction>(
    job.action ?? { type: "command", command: job.command },
  );
  const [bindings, setBindings] = useState<WebhookSubscription[]>(job.webhooks ?? []);
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
    if (!name.trim() || !jobActionValid(action) || (triggerType === "webhook" && !bindings.length))
      return;
    const input: UpdateJobInput & { id: string } = {
      id: job.id,
      name: name.trim(),
      description: description.trim(),
      action,
      webhooks: triggerType === "webhook" ? bindings : [],
      trigger_type: triggerType,
      cron_expr: triggerType === "cron" ? cronExpr.trim() || undefined : undefined,
      timeout_secs: Number.parseInt(timeoutSecs, 10) || undefined,
      max_retries: Number.parseInt(maxRetries, 10),
      overlap,
      notify_on: notifyOn,
      enabled,
    };
    updateJob.mutate(input, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-border max-w-lg max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm font-medium text-on-surface">
            Edit job
          </DialogTitle>
        </DialogHeader>
        <form id="edit-job-form" onSubmit={handleSubmit} className="space-y-3 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-xs font-medium text-outline">Name *</Label>
            <Input
              aria-label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-background border-control-border text-on-surface font-body text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-xs font-medium text-outline">Description</Label>
            <Input
              aria-label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="bg-background border-control-border text-on-surface font-body text-sm"
            />
          </div>
          <JobActionFields value={action} onChange={setAction} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Trigger Type</Label>
              <Select
                value={triggerType}
                onValueChange={(v) => setTriggerType(v as JobTriggerType)}
              >
                <SelectTrigger
                  aria-label="Trigger type"
                  data-testid="job-trigger-type"
                  className="bg-background border-control-border text-on-surface font-body text-sm min-h-11"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-border">
                  {TRIGGER_TYPES.map((t) => (
                    <SelectItem
                      key={t}
                      value={t}
                      data-testid={`job-trigger-${t}`}
                      className="font-body text-sm"
                    >
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {triggerType === "webhook" && (
              <div className="sm:col-span-2">
                <WebhookPicker
                  value={bindings}
                  onChange={setBindings}
                  projectId={job.project_id ?? undefined}
                />
              </div>
            )}
            {triggerType === "cron" && (
              <div className="space-y-1.5">
                <Label className="font-label text-xs font-medium text-outline">
                  Cron Expression
                </Label>
                <Input
                  aria-label="Cron expression"
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="*/5 * * * *"
                  className="bg-background border-control-border text-on-surface font-mono text-xs"
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Timeout (s)</Label>
              <Input
                aria-label="Timeout in seconds"
                type="number"
                min={1}
                required
                value={timeoutSecs}
                onChange={(e) => setTimeoutSecs(e.target.value)}
                className="bg-background border-control-border text-on-surface font-body text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Max Retries</Label>
              <Input
                aria-label="Maximum retries"
                type="number"
                min={0}
                required
                value={maxRetries}
                onChange={(e) => setMaxRetries(e.target.value)}
                className="bg-background border-control-border text-on-surface font-body text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Overlap</Label>
              <Select value={overlap} onValueChange={(v) => setOverlap(v as typeof overlap)}>
                <SelectTrigger
                  aria-label="Overlap"
                  className="bg-background border-control-border text-on-surface font-body text-sm min-h-11"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-border">
                  {OVERLAPS.map((o) => (
                    <SelectItem key={o} value={o} className="font-body text-sm">
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Notify On</Label>
              <Select value={notifyOn} onValueChange={(v) => setNotifyOn(v as typeof notifyOn)}>
                <SelectTrigger
                  aria-label="Notify on"
                  className="bg-background border-control-border text-on-surface font-body text-sm min-h-11"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface border-border">
                  {NOTIFY_OPTIONS.map((n) => (
                    <SelectItem key={n} value={n} className="font-body text-sm">
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Enabled</Label>
              <button
                type="button"
                onClick={() => setEnabled(!enabled)}
                className={`w-full min-h-11 rounded-md flex items-center justify-center border font-label text-xs font-medium transition-colors ${
                  enabled
                    ? "bg-surface-highest text-on-surface border-border"
                    : "bg-background text-outline border-border"
                }`}
              >
                {enabled ? "\u25CF Enabled" : "\u25CB Disabled"}
              </button>
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="font-label text-xs text-outline"
          >
            Cancel
          </Button>
          <Button
            data-testid="job-edit-submit"
            form="edit-job-form"
            type="submit"
            size="sm"
            disabled={
              updateJob.isPending ||
              !name.trim() ||
              !jobActionValid(action) ||
              (triggerType === "webhook" && !bindings.length)
            }
            className="font-label text-xs bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {updateJob.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
        {updateJob.error && (
          <p role="alert" className="text-sm text-error">
            {updateJob.error.message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
