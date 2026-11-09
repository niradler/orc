import { ChatAgentOptionsSchema } from "@orc/core/chat-options";
import { type JobAction, JobActionSchema, type WebhookSubscription } from "@orc/core/job-actions";
import {
  type JobEnvironment,
  JobEnvironmentSchema,
  type JobSettings,
  JobSettingsSchema,
} from "@orc/core/job-settings";
import { useState } from "react";
import type { CreateJobInput, Job, JobTriggerType } from "@/api/client";
import { FormDialog } from "@/components/FormDialog";
import { JobActionFields, jobActionValid } from "@/components/JobActionFields";
import { JobDestinationFields } from "@/components/JobDestinationFields";
import { JobEnvironmentFields } from "@/components/JobEnvironmentFields";
import { JobScheduleFields } from "@/components/JobScheduleFields";
import { WebhookPicker } from "@/components/JobWebhooks";
import { Button } from "@/components/ui/button";
import { DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormStepActions, FormStepPanel, FormSteps, useFormSteps } from "@/components/useFormSteps";
import { useCreateJob, useUpdateJob } from "@/hooks/useJobs";
import { useProjects } from "@/hooks/useProjects";

export function JobEditorDialog({
  job,
  defaultProjectId,
  open,
  onClose,
}: {
  job?: Job;
  defaultProjectId?: string;
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateJob();
  const update = useUpdateJob();
  const { data: projects } = useProjects();
  const steps = useFormSteps(
    [
      { id: "trigger", label: "Trigger" },
      { id: "destination", label: "Destination" },
      { id: "settings", label: "Settings" },
    ],
    open,
  );
  const initial = {
    name: job?.name ?? "",
    description: job?.description ?? "",
    project_id: job?.project_id ?? defaultProjectId ?? "",
    working_dir: job?.working_dir ?? "",
    action: job?.action ?? { type: "command" as const, command: job?.command ?? "" },
    trigger_type: job?.trigger_type ?? "manual",
    cron_expr: job?.cron_expr ?? "",
    timeout_secs: job?.timeout_secs ?? 300,
    max_retries: job?.max_retries ?? 0,
    overlap: job?.overlap ?? "skip",
    notify_on: job?.notify_on ?? "failure",
    enabled: job?.enabled ?? false,
    webhooks: job?.webhooks ?? ([] as WebhookSubscription[]),
    environment: job?.environment ?? ([] as JobEnvironment),
    settings:
      job?.settings ??
      ({
        timezone: job?.schedule_timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(job
          ? { shell: { executable: "sh", args: ["-c"] }, inherit_project_directory: false }
          : {}),
      } as JobSettings),
  };
  const [draft, setDraft] = useState(initial);
  const initialOptions =
    job?.action?.type === "agent" && job.action.options
      ? JSON.stringify(
          job.action.options.runtime === "claude-sdk"
            ? job.action.options.options
            : job.action.options.args,
          null,
          2,
        )
      : "";
  const [optionsDraft, setOptionsDraft] = useState(initialOptions);
  const busy = create.isPending || update.isPending;
  function change<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  function save(afterSave: () => void): void {
    if (!jobActionValid(draft.action)) {
      steps.invalid("destination", "Complete the job action.");
      return;
    }
    if (draft.trigger_type === "cron" && !draft.cron_expr) {
      steps.invalid("trigger", "Choose a schedule or enter a cron expression.");
      return;
    }
    if (draft.trigger_type === "webhook" && !draft.webhooks.length) {
      steps.invalid("trigger", "Select at least one webhook.");
      return;
    }
    const settings = JobSettingsSchema.safeParse(draft.settings);
    if (!settings.success) {
      steps.invalid(
        settings.error.issues[0].path[0] === "timezone" ? "trigger" : "destination",
        settings.error.issues[0].message,
      );
      return;
    }
    const environment = JobEnvironmentSchema.safeParse(draft.environment);
    if (!environment.success) {
      steps.invalid("settings", environment.error.issues[0].message);
      return;
    }
    let action = draft.action;
    if (action.type === "agent" && !optionsDraft.trim()) {
      const { options: _options, ...withoutOptions } = action;
      action = withoutOptions;
    }
    if (action.type === "agent" && optionsDraft.trim()) {
      const runtime =
        action.backend === "claude"
          ? "claude-sdk"
          : action.backend === "codex-cli"
            ? "codex"
            : "acpx";
      try {
        const raw: unknown = JSON.parse(optionsDraft);
        const options = ChatAgentOptionsSchema.parse(
          runtime === "claude-sdk" ? { runtime, options: raw } : { runtime, args: raw },
        );
        action = { ...action, options };
      } catch {
        steps.invalid("destination", "Enter valid supported agent launch options as JSON.");
        return;
      }
    }
    const checkedAction = JobActionSchema.safeParse(action);
    if (!checkedAction.success) {
      steps.invalid("destination", checkedAction.error.issues[0].message);
      return;
    }
    const input: CreateJobInput = {
      ...draft,
      action,
      name: draft.name.trim(),
      project_id: draft.project_id || null,
      working_dir: draft.working_dir.trim(),
      settings: settings.data,
      environment: environment.data,
      cron_expr: draft.trigger_type === "cron" ? draft.cron_expr.trim() : undefined,
      webhooks: draft.trigger_type === "webhook" ? draft.webhooks : [],
    };
    if (job) update.mutate({ ...input, id: job.id }, { onSuccess: afterSave });
    else create.mutate(input, { onSuccess: afterSave });
  }
  const control =
    "min-h-11 w-full rounded-md border border-control-border bg-background px-3 text-sm sm:min-h-8";
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      busy={busy}
      dirty={JSON.stringify(draft) !== JSON.stringify(initial) || optionsDraft !== initialOptions}
    >
      {(requestClose, closeAfterSave) => (
        <>
          <DialogHeader>
            <DialogTitle>{job ? "Edit job" : "New job"}</DialogTitle>
          </DialogHeader>
          <form
            ref={steps.form}
            noValidate
            className="min-h-0"
            onSubmit={(event) => steps.submit(event, () => save(closeAfterSave))}
          >
            <FormSteps steps={steps}>
              <div className="work-form-body space-y-4">
                <FormStepPanel steps={steps} id="trigger">
                  <div className="space-y-1.5">
                    <Label htmlFor="job-name">Name</Label>
                    <Input
                      id="job-name"
                      aria-label="Name"
                      data-testid="job-name-input"
                      required
                      maxLength={100}
                      value={draft.name}
                      onChange={(event) => change("name", event.target.value)}
                      autoFocus
                      placeholder="Check for Sentry issues"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="job-trigger-type">Trigger</Label>
                    <select
                      id="job-trigger-type"
                      data-testid="job-trigger-type"
                      className={control}
                      value={draft.trigger_type}
                      onChange={(event) => {
                        const trigger = event.target.value as JobTriggerType;
                        setDraft({
                          ...draft,
                          trigger_type: trigger,
                          cron_expr:
                            trigger === "cron"
                              ? draft.cron_expr || "0 9 * * 1,2,3,4,5"
                              : draft.cron_expr,
                        });
                      }}
                    >
                      <option value="manual">Manual</option>
                      <option value="cron">Schedule</option>
                      <option value="webhook">Webhook</option>
                      {!["manual", "cron", "webhook"].includes(draft.trigger_type) && (
                        <option value={draft.trigger_type}>{draft.trigger_type} (existing)</option>
                      )}
                    </select>
                  </div>
                  {draft.trigger_type === "cron" && (
                    <div className="md:col-span-2">
                      <JobScheduleFields
                        cron={draft.cron_expr}
                        timezone={draft.settings.timezone ?? "UTC"}
                        onChange={(value) => change("cron_expr", value)}
                        onTimezone={(timezone) =>
                          change("settings", { ...draft.settings, timezone })
                        }
                      />
                      {job?.next_run_at && (
                        <p className="mt-3 text-xs text-outline">
                          Saved schedule’s next run:{" "}
                          {new Date(job.next_run_at).toLocaleString(undefined, {
                            timeZone: job.settings?.timezone ?? "UTC",
                          })}{" "}
                          ({job.settings?.timezone ?? "UTC"})
                        </p>
                      )}
                    </div>
                  )}
                  {draft.trigger_type === "webhook" && (
                    <div className="md:col-span-2">
                      <WebhookPicker
                        value={draft.webhooks}
                        onChange={(value) => change("webhooks", value)}
                        projectId={draft.project_id || undefined}
                      />
                    </div>
                  )}
                  <div className="space-y-1.5 md:col-span-2">
                    <Label htmlFor="job-description">Description (optional)</Label>
                    <Input
                      id="job-description"
                      value={draft.description}
                      onChange={(event) => change("description", event.target.value)}
                    />
                  </div>
                </FormStepPanel>
                <FormStepPanel steps={steps} id="destination">
                  <div className="space-y-1.5">
                    <Label htmlFor="job-project">Project</Label>
                    <select
                      id="job-project"
                      data-testid="job-project-select"
                      className={control}
                      value={draft.project_id}
                      onChange={(event) =>
                        setDraft({ ...draft, project_id: event.target.value, webhooks: [] })
                      }
                    >
                      <option value="">None</option>
                      {projects?.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {draft.action.type !== "task" && (
                    <div className="space-y-1.5">
                      <Label htmlFor="job-directory">Working directory</Label>
                      <Input
                        id="job-directory"
                        aria-label="Working directory"
                        value={draft.working_dir}
                        onChange={(event) => change("working_dir", event.target.value)}
                        placeholder={
                          draft.action.type === "command" &&
                          draft.settings.inherit_project_directory === false
                            ? "Use host working directory (existing job)"
                            : "Use project directory"
                        }
                      />
                      <p className="text-xs text-outline">
                        A path on the selected host. Worktrees use this repository as their source.
                      </p>
                    </div>
                  )}
                  <div className="md:col-span-2">
                    <JobActionFields
                      value={draft.action}
                      executionHost={draft.settings.host}
                      cwd={
                        draft.working_dir ||
                        projects?.find((project) => project.id === draft.project_id)?.scope ||
                        undefined
                      }
                      onChange={(action: JobAction) => {
                        if (
                          action.type === "agent" &&
                          draft.action.type === "agent" &&
                          action.backend !== draft.action.backend
                        )
                          setOptionsDraft("");
                        setDraft({
                          ...draft,
                          action,
                          settings:
                            !job && action.type === "agent" && !draft.settings.workspace
                              ? {
                                  ...draft.settings,
                                  workspace: {
                                    mode: "worktree",
                                    base_ref: "HEAD",
                                    cleanup_on_success: false,
                                  },
                                }
                              : draft.settings,
                        });
                      }}
                    />
                  </div>
                  {draft.action.type === "agent" && (
                    <details className="md:col-span-2 space-y-2">
                      <summary className="min-h-11 cursor-pointer text-sm">
                        Advanced agent options
                      </summary>
                      <Label htmlFor="job-agent-options">
                        {draft.action.backend === "claude"
                          ? "SDK options (JSON object)"
                          : "Launch arguments (JSON array)"}
                      </Label>
                      <textarea
                        id="job-agent-options"
                        data-testid="job-agent-options"
                        rows={4}
                        maxLength={20000}
                        className="w-full rounded-md border border-control-border bg-background p-3 font-mono text-xs"
                        value={optionsDraft}
                        onChange={(event) => setOptionsDraft(event.target.value)}
                      />
                      <p className="text-xs text-outline">
                        Uses the same supported options as Chat. Set the model above; keep
                        credentials in environment variables. Unsupported options are rejected.
                      </p>
                    </details>
                  )}
                  <div className="md:col-span-2">
                    <JobDestinationFields
                      action={draft.action}
                      settings={draft.settings}
                      onChange={(value) => change("settings", value)}
                    />
                  </div>
                </FormStepPanel>
                <FormStepPanel steps={steps} id="settings">
                  <label className="flex min-h-11 items-center gap-3 text-sm md:col-span-2">
                    <input
                      type="checkbox"
                      data-testid={job ? "job-edit-enabled" : "job-create-enabled"}
                      checked={draft.enabled}
                      onChange={(event) => change("enabled", event.target.checked)}
                    />
                    Enable this job
                  </label>
                  <p className="text-xs text-outline md:col-span-2">
                    Disabled jobs stay saved. You can still run them manually.
                  </p>
                  {draft.action.type !== "task" && (
                    <div className="md:col-span-2">
                      <JobEnvironmentFields
                        value={draft.environment}
                        onChange={(value) => change("environment", value)}
                      />
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label htmlFor="job-timeout">Timeout (seconds)</Label>
                    <Input
                      id="job-timeout"
                      type="number"
                      required
                      min={1}
                      value={draft.timeout_secs}
                      onChange={(event) => change("timeout_secs", Number(event.target.value))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="job-retries">Maximum retries</Label>
                    <Input
                      id="job-retries"
                      type="number"
                      required
                      min={0}
                      value={draft.max_retries}
                      onChange={(event) => change("max_retries", Number(event.target.value))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="job-overlap">When a run is already active</Label>
                    <select
                      id="job-overlap"
                      className={control}
                      value={draft.overlap}
                      onChange={(event) =>
                        change("overlap", event.target.value as typeof draft.overlap)
                      }
                    >
                      <option value="skip">Skip new run</option>
                      <option value="queue">Queue</option>
                      <option value="kill">Stop previous run</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="job-notify">Notify on</Label>
                    <select
                      id="job-notify"
                      className={control}
                      value={draft.notify_on}
                      onChange={(event) =>
                        change("notify_on", event.target.value as typeof draft.notify_on)
                      }
                    >
                      <option value="never">Never</option>
                      <option value="failure">Failure</option>
                      <option value="always">Every run</option>
                    </select>
                  </div>
                </FormStepPanel>
                {(steps.error || create.error || update.error) && (
                  <p role="alert" className="text-sm text-error md:col-span-2">
                    {steps.error || create.error?.message || update.error?.message}
                  </p>
                )}
              </div>
              <DialogFooter className="work-form-footer gap-2">
                <Button type="button" variant="ghost" disabled={busy} onClick={requestClose}>
                  Cancel
                </Button>
                <FormStepActions steps={steps} busy={busy}>
                  <Button
                    type="submit"
                    data-testid={job ? "job-edit-submit" : "job-submit"}
                    disabled={busy}
                  >
                    {busy ? "Saving…" : job ? "Save changes" : "Create job"}
                  </Button>
                </FormStepActions>
              </DialogFooter>
            </FormSteps>
          </form>
        </>
      )}
    </FormDialog>
  );
}
