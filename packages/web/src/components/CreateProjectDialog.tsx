import { useState } from "react";
import type { CreateProjectInput, ProjectStatus } from "@/api/client";
import { api } from "@/api/client";
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
import { Textarea } from "@/components/ui/textarea";
import { useCreateProject } from "@/hooks/useProjects";
import { PROJECT_STATUSES } from "@/lib/project-statuses";

export function CreateProjectDialog({
  open,
  onClose,
  onFirstTask,
}: {
  open: boolean;
  onClose: () => void;
  onFirstTask: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [tags, setTags] = useState("");
  const [scope, setScope] = useState("");
  const [gitRemoteUrl, setGitRemoteUrl] = useState("");
  const [maxWorkers, setMaxWorkers] = useState("");
  const createProject = useCreateProject();
  const [firstTask, setFirstTask] = useState(true);
  const [folderError, setFolderError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
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
      git_remote_url: gitRemoteUrl.trim() || undefined,
      max_workers: maxWorkers ? Number(maxWorkers) : undefined,
    };
    createProject.mutate(input, {
      onSuccess: (project) => {
        onClose();
        if (firstTask) onFirstTask(project.id);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-outline-variant max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline text-base  text-on-surface">
            New project
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-sm  text-muted-foreground">Name *</Label>
            <Input
              aria-label="Name"
              data-testid="project-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="project-name"
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <Label className="font-label text-sm  text-muted-foreground">Max Workers</Label>
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
          <div className="space-y-1.5">
            <Label className="font-label text-sm  text-muted-foreground">
              Project folder on the ORC machine
            </Label>
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
              onClick={async () => {
                try {
                  const result = await api.terminals.pickFolder(scope || undefined);
                  if (result.path) setScope(result.path);
                  setFolderError("");
                } catch (error) {
                  setFolderError(error instanceof Error ? error.message : String(error));
                }
              }}
            >
              Choose folder
            </Button>
            {folderError && (
              <p role="alert" className="text-xs text-destructive">
                {folderError}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="project-git-remote-url"
              className="font-label text-sm text-muted-foreground"
            >
              Git remote URL (optional)
            </Label>
            <Input
              id="project-git-remote-url"
              className="bg-background border-control-border text-on-surface font-body text-sm"
              data-testid="project-git-remote-url"
              value={gitRemoteUrl}
              onChange={(event) => setGitRemoteUrl(event.target.value)}
              placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git"
            />
            <p className="text-xs text-muted-foreground">
              Repository address without credentials. Leave blank if not needed.
            </p>
          </div>
          <label className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              data-testid="project-first-task"
              checked={firstTask}
              onChange={(event) => setFirstTask(event.target.checked)}
            />
            Create the first task after saving
          </label>
          {createProject.error && (
            <p role="alert" className="text-xs text-destructive">
              {createProject.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="font-label text-sm text-muted-foreground"
            >
              Cancel
            </Button>
            <Button
              data-testid="project-submit"
              type="submit"
              size="sm"
              disabled={createProject.isPending || !name.trim()}
              className="font-label text-sm bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {createProject.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
