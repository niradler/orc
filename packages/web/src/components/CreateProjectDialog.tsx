import { DEFAULT_GITHUB_STATUS_LABELS, type GithubSyncConfig } from "@orc/core/github-sync";
import {
  defaultWorkspaceEnvironment,
  type WorkspaceEnvironment,
  WorkspaceEnvironmentSchema,
} from "@orc/core/workspace-settings";
import { useState } from "react";
import type { CreateProjectInput, ProjectStatus } from "@/api/client";
import { FolderPickerDialog } from "@/components/FolderPickerDialog";
import { FormDialog } from "@/components/FormDialog";
import { GithubSyncFields } from "@/components/GithubSyncFields";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FormStepActions, FormStepPanel, FormSteps, useFormSteps } from "@/components/useFormSteps";
import { WorkspaceEnvironmentFields } from "@/components/WorkspaceEnvironmentFields";
import { useCreateProject } from "@/hooks/useProjects";
import { useSsh } from "@/hooks/useSsh";
import { PROJECT_STATUSES } from "@/lib/project-statuses";

export function CreateProjectDialog({
  open,
  onClose,
  onFirstTask,
  initialName,
  initialScope,
  onCreated,
  allowFirstTask = true,
}: {
  open: boolean;
  onClose: () => void;
  onFirstTask: (id: string) => void;
  initialName?: string;
  initialScope?: string;
  onCreated?: (id: string) => void;
  allowFirstTask?: boolean;
}) {
  const steps = useFormSteps(
    [
      { id: "details", label: "Details" },
      { id: "configuration", label: "Configuration" },
      { id: "workspace", label: "Workspace" },
    ],
    open,
  );
  const [name, setName] = useState(initialName ?? "");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [tags, setTags] = useState("");
  const [scope, setScope] = useState(initialScope ?? "");
  const [host, setHost] = useState("");
  const { data: ssh } = useSsh();
  const [gitRemoteUrl, setGitRemoteUrl] = useState("");
  const [githubSync, setGithubSync] = useState<GithubSyncConfig>({
    enabled: false,
    status_labels: DEFAULT_GITHUB_STATUS_LABELS,
  });
  const [maxWorkers, setMaxWorkers] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceEnvironment>(defaultWorkspaceEnvironment);
  const createProject = useCreateProject();
  const [firstTask, setFirstTask] = useState(allowFirstTask);
  const [browsing, setBrowsing] = useState(false);
  const dirty =
    JSON.stringify([
      name,
      description,
      status,
      tags,
      scope,
      host,
      gitRemoteUrl,
      maxWorkers,
      firstTask,
      githubSync,
      workspace,
    ]) !==
    JSON.stringify([
      initialName ?? "",
      "",
      "active",
      "",
      initialScope ?? "",
      "",
      "",
      "",
      allowFirstTask,
      { enabled: false, status_labels: DEFAULT_GITHUB_STATUS_LABELS },
      defaultWorkspaceEnvironment(),
    ]);
  function resetForm() {
    steps.reset();
    setName(initialName ?? "");
    setDescription("");
    setStatus("active");
    setTags("");
    setScope(initialScope ?? "");
    setHost("");
    setGitRemoteUrl("");
    setGithubSync({ enabled: false, status_labels: DEFAULT_GITHUB_STATUS_LABELS });
    setMaxWorkers("");
    setFirstTask(allowFirstTask);
    setWorkspace(defaultWorkspaceEnvironment());
    setBrowsing(false);
    createProject.reset();
  }

  const handleSubmit = (e: React.FormEvent, closeAfterSave: () => void) => {
    e.preventDefault();
    if (!name.trim()) return;
    const parsedWorkspace = WorkspaceEnvironmentSchema.safeParse(workspace);
    if (!parsedWorkspace.success) {
      steps.invalid("workspace", parsedWorkspace.error.issues[0].message);
      return;
    }
    const input: CreateProjectInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      status,
      tags: tags.trim()
        ? tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
      scope: scope.trim() || undefined,
      host: host.trim() || undefined,
      git_remote_url: gitRemoteUrl.trim() || undefined,
      github_sync: githubSync,
      max_workers: maxWorkers ? Number(maxWorkers) : undefined,
      workspace: parsedWorkspace.data,
    };
    createProject.mutate(input, {
      onSuccess: (project) => {
        resetForm();
        closeAfterSave();
        onCreated?.(project.id);
        if (firstTask) onFirstTask(project.id);
      },
    });
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      onDiscard={resetForm}
      dirty={dirty}
      busy={createProject.isPending}
    >
      {(requestClose, closeAfterSave) => (
        <>
          <DialogHeader>
            <DialogTitle className="font-headline text-base  text-on-surface">
              New project
            </DialogTitle>
          </DialogHeader>
          <form
            noValidate
            ref={steps.form}
            onSubmit={(event) => steps.submit(event, () => handleSubmit(event, closeAfterSave))}
            className="min-h-0"
          >
            <FormSteps steps={steps}>
              <div className="work-form-body space-y-4">
                <FormStepPanel steps={steps} id="details">
                  <div className="space-y-1.5">
                    <Label className="font-label text-sm  text-muted-foreground">Name *</Label>
                    <Input
                      aria-label="Name"
                      data-testid="project-name-input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="project-name"
                      required
                      className="bg-background border-control-border text-on-surface font-body text-sm"
                      autoFocus
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="font-label text-sm  text-muted-foreground">Description</Label>
                    <Textarea
                      aria-label="Description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Short description..."
                      rows={2}
                      className="bg-background border-control-border text-on-surface font-body text-sm resize-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="font-label text-sm  text-muted-foreground">Status</Label>
                    <Select value={status} onValueChange={(v) => setStatus(v as ProjectStatus)}>
                      <SelectTrigger
                        aria-label="Status"
                        className="bg-background border-control-border text-on-surface font-label text-sm"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-surface border-outline-variant">
                        {PROJECT_STATUSES.map((s) => (
                          <SelectItem key={s} value={s} className="font-label text-sm">
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="font-label text-sm  text-muted-foreground">
                      Tags (comma separated)
                    </Label>
                    <Input
                      aria-label="Tags (comma separated)"
                      value={tags}
                      onChange={(e) => setTags(e.target.value)}
                      placeholder="backend, api, v2"
                      className="bg-background border-control-border text-on-surface font-body text-sm"
                    />
                  </div>
                </FormStepPanel>
                <FormStepPanel steps={steps} id="configuration">
                  <div className="space-y-1.5">
                    <div className="flex min-h-11 items-center lg:min-h-8">
                      <Label className="font-label text-sm text-muted-foreground">
                        Project folder on the ORC machine
                      </Label>
                    </div>
                    <Input
                      aria-label="Project folder on the ORC machine"
                      data-testid="project-folder-input"
                      value={scope}
                      onChange={(e) => setScope(e.target.value)}
                      placeholder="Absolute project folder (required to run tasks)"
                      className="bg-background border-control-border text-on-surface font-body text-sm"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="project-pick-folder"
                      onClick={() => setBrowsing(true)}
                    >
                      Choose folder
                    </Button>
                    <FolderPickerDialog
                      open={browsing}
                      onOpenChange={setBrowsing}
                      host={host === "local" ? null : host || ssh?.host || null}
                      initial={scope}
                      onPick={setScope}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex min-h-11 items-center gap-1 lg:min-h-8">
                      <Label
                        htmlFor="project-host"
                        className="font-label text-sm text-muted-foreground"
                      >
                        Execution host
                      </Label>
                      <HelpPopover label="execution host" testId="project-host-help">
                        Where sessions for this project run by default. Leave on Settings default to
                        follow global execution host settings.
                      </HelpPopover>
                    </div>
                    <select
                      id="project-host"
                      data-testid="project-host"
                      className="form-control form-control-single w-full bg-background border-control-border text-on-surface font-body text-sm"
                      value={host}
                      onChange={(event) => setHost(event.target.value)}
                    >
                      <option value="">
                        Settings default{ssh?.host ? ` (${ssh.host})` : " (local)"}
                      </option>
                      <option value="local">This computer (local)</option>
                      {Array.from(
                        new Set([
                          ...(ssh?.hosts ?? []),
                          ...(host && host !== "local" ? [host] : []),
                        ]),
                      ).map((entry) => (
                        <option key={entry} value={entry}>
                          {entry}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5 md:col-span-2">
                    <div className="flex items-center gap-1">
                      <Label
                        htmlFor="project-git-remote-url"
                        className="font-label text-sm text-muted-foreground"
                      >
                        Git remote URL (optional)
                      </Label>
                      <HelpPopover label="git remote URL" testId="project-git-remote-help">
                        Repository address without credentials. Leave blank if not needed.
                      </HelpPopover>
                    </div>
                    <Input
                      id="project-git-remote-url"
                      className="bg-background border-control-border text-on-surface font-body text-sm"
                      data-testid="project-git-remote-url"
                      value={gitRemoteUrl}
                      onChange={(event) => setGitRemoteUrl(event.target.value)}
                      placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="font-label text-sm  text-muted-foreground">Max workers</Label>
                    <Input
                      aria-label="Max Workers"
                      type="number"
                      min={1}
                      value={maxWorkers}
                      onChange={(e) => setMaxWorkers(e.target.value)}
                      placeholder="1"
                      className="bg-background border-control-border text-on-surface font-body text-sm"
                    />
                  </div>
                  {allowFirstTask && (
                    <label className="flex min-h-11 items-center gap-2 text-[13px] text-muted-foreground md:col-span-2">
                      <input
                        type="checkbox"
                        data-testid="project-first-task"
                        checked={firstTask}
                        onChange={(event) => setFirstTask(event.target.checked)}
                      />
                      Create the first task after saving
                    </label>
                  )}
                  <GithubSyncFields value={githubSync} onChange={setGithubSync} />
                </FormStepPanel>
                <FormStepPanel steps={steps} id="workspace">
                  <WorkspaceEnvironmentFields value={workspace} onChange={setWorkspace} />
                </FormStepPanel>
                {createProject.error && (
                  <p role="alert" className="text-sm text-destructive md:col-span-2">
                    {createProject.error.message}
                  </p>
                )}
                {steps.error && (
                  <p role="alert" className="text-sm text-error">
                    {steps.error}
                  </p>
                )}
              </div>
              <DialogFooter className="work-form-footer">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={requestClose}
                  className="font-label text-sm text-muted-foreground"
                >
                  Cancel
                </Button>
                <FormStepActions steps={steps} busy={createProject.isPending}>
                  <Button
                    data-testid="project-submit"
                    type="submit"
                    size="sm"
                    disabled={createProject.isPending}
                    className="font-label text-sm bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {createProject.isPending ? "Creating…" : "Create project"}
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
