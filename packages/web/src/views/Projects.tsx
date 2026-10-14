import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  CreateProjectInput,
  Project,
  ProjectStatus,
  ProjectSummary,
  UpdateProjectInput,
} from "@/api/client";
import { api } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CreateTaskDialog } from "@/components/CreateTaskDialog";
import { DetailField } from "@/components/DetailField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { TaskDetailSheet } from "@/components/TaskDetailSheet";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ViewHeader } from "@/components/ViewHeader";
import { useDetailRoute } from "@/hooks/useDetailRoute";
import {
  useCreateProject,
  useDeleteProject,
  useProjectSummary,
  useProjects,
  useUpdateProject,
} from "@/hooks/useProjects";
import { useViewParam } from "@/lib/view-params";

const STATUS_TABS: Array<{ value: ProjectStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "paused", label: "Paused" },
];

const PROJECT_STATUSES: ProjectStatus[] = ["active", "archived", "paused"];

export default function Projects() {
  const { data: projects, isLoading, error, refetch } = useProjects();
  const [filter, setFilter] = useViewParam<ProjectStatus | "all">("status", "all", [
    "all",
    "active",
    "archived",
    "paused",
  ]);
  const [creating, setCreating] = useState(false);
  const [firstTaskProject, setFirstTaskProject] = useState<string | null>(null);
  const [createdTask, setCreatedTask] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const {
    selectedId: editingId,
    openDetail: openEdit,
    closeDetail: closeEdit,
  } = useDetailRoute("/projects", "projectId");
  const deleteProject = useDeleteProject();
  const editing = editingId ? ((projects ?? []).find((p) => p.id === editingId) ?? null) : null;

  const visible = useMemo(() => {
    const all = projects ?? [];
    return filter === "all" ? all : all.filter((p) => p.status === filter);
  }, [projects, filter]);

  const counts = useMemo(() => {
    return (projects ?? []).reduce(
      (acc, p) => {
        acc[p.status] = (acc[p.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
  }, [projects]);

  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Projects"
        meta={`${(projects ?? []).length} total`}
        action={
          <Button
            data-testid="new-project-button"
            size="sm"
            onClick={() => setCreating(true)}
            className="font-label text-sm  bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
          >
            <Plus size={12} className="mr-1" />
            New project
          </Button>
        }
      />

      <Tabs
        value={filter}
        onValueChange={(v) => setFilter(v as ProjectStatus | "all")}
        className="mb-4"
      >
        <TabsList className="bg-surface-highest border border-outline-variant gap-0 h-auto max-w-full flex-wrap justify-start p-0">
          {STATUS_TABS.map(({ value, label }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="font-label text-sm  px-4 py-2 rounded-none
                data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none
                text-muted-foreground hover:text-on-surface"
            >
              {label}
              {value !== "all" && counts[value] != null && (
                <span className="ml-1.5 text-xs bg-surface-highest px-1.5 py-0.5 rounded-sm">
                  {counts[value]}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={filter}>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <Skeleton key={i} className="h-12 w-full bg-surface-highest" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState message="No projects" />
          ) : (
            <div className="border border-outline-variant rounded-sm overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-outline-variant hover:bg-transparent">
                    <TableHead className="font-label text-sm  text-muted-foreground">
                      Name
                    </TableHead>
                    <TableHead className="font-label text-sm  text-muted-foreground">
                      Description
                    </TableHead>
                    <TableHead className="font-label text-sm  text-muted-foreground w-28">
                      Status
                    </TableHead>
                    <TableHead className="font-label text-sm  text-muted-foreground w-36">
                      Tags
                    </TableHead>
                    <TableHead className="font-label text-sm  text-muted-foreground w-24">
                      Max Workers
                    </TableHead>
                    <TableHead className="font-label text-sm  text-muted-foreground w-24">
                      Created
                    </TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((p) => (
                    <TableRow
                      key={p.id}
                      data-testid="project-row"
                      data-project-id={p.id}
                      data-project-name={p.name}
                      className="border-b border-outline-variant/50 hover:bg-surface-low cursor-pointer"
                      onClick={() => openEdit(p.id)}
                    >
                      <TableCell className="font-body text-sm font-semibold text-on-surface">
                        <button
                          type="button"
                          className="min-h-11 text-left hover:text-primary"
                          aria-label={`Edit project: ${p.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            openEdit(p.id);
                          }}
                        >
                          {p.name}
                        </button>
                      </TableCell>
                      <TableCell className="font-body text-sm text-muted-foreground max-w-xs truncate">
                        {p.description ?? "\u2014"}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex rounded-md border px-2 py-1 text-xs font-medium capitalize ${p.status === "active" ? "border-secondary/30 bg-secondary/10 text-secondary" : p.status === "paused" ? "border-tertiary/30 bg-tertiary/10 text-tertiary" : "border-outline-variant bg-surface-high text-muted-foreground"}`}
                        >
                          {p.status}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(p.tags ?? []).map((t) => (
                            <span
                              key={t}
                              className="font-label text-sm px-1.5 py-0.5 bg-surface-highest text-muted-foreground border border-outline-variant/50"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="font-label text-sm text-on-surface text-center">
                        {p.max_workers ?? "\u2014"}
                      </TableCell>
                      <TableCell className="font-label text-sm text-muted-foreground">
                        {new Date(p.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          data-testid="project-delete"
                          aria-label={`Delete project: ${p.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleting(p);
                          }}
                          className="text-muted-foreground hover:text-error transition-colors p-1"
                        >
                          <Trash2 size={12} />
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>
      {creating && (
        <CreateProjectDialog
          open={creating}
          onClose={() => setCreating(false)}
          onFirstTask={setFirstTaskProject}
        />
      )}
      {firstTaskProject && (
        <CreateTaskDialog
          open
          defaultProjectId={firstTaskProject}
          onClose={() => setFirstTaskProject(null)}
          onCreated={setCreatedTask}
        />
      )}
      <TaskDetailSheet
        taskId={createdTask}
        open={Boolean(createdTask)}
        onOpenChange={(open) => {
          if (!open) setCreatedTask(null);
        }}
      />

      {editing && (
        <EditProjectDialog
          key={editing.id}
          open={Boolean(editing)}
          project={editing}
          onClose={closeEdit}
          onFirstTask={(id) => {
            closeEdit();
            setFirstTaskProject(id);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          open={Boolean(deleting)}
          title="Delete project"
          description="This will delete all associated tasks, memories, and jobs. This action cannot be undone."
          confirmLabel="Delete"
          variant="destructive"
          isPending={deleteProject.isPending}
          onConfirm={() => {
            deleteProject.mutate(deleting.id, {
              onSuccess: () => setDeleting(null),
            });
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

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
      <DialogContent className="bg-surface border-outline-variant max-w-md">
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
              className="bg-background border-outline-variant text-on-surface font-body text-sm"
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
              className="bg-background border-outline-variant text-on-surface font-body text-sm resize-none"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-sm  text-muted-foreground">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as ProjectStatus)}>
                <SelectTrigger
                  aria-label="Status"
                  className="bg-background border-outline-variant text-on-surface font-label text-sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-highest border-outline-variant">
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
                className="bg-background border-outline-variant text-on-surface font-body text-sm"
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
              className="bg-background border-outline-variant text-on-surface font-body text-sm"
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
              className="bg-background border-outline-variant text-on-surface font-body text-sm"
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
              className="font-label text-sm bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
            >
              {createProject.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditProjectDialog({
  open,
  project,
  onClose,
  onFirstTask,
}: {
  open: boolean;
  project: Project;
  onClose: () => void;
  onFirstTask: (id: string) => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [tags, setTags] = useState((project.tags ?? []).join(", "));
  const [scope, setScope] = useState(project.scope ?? "");
  const [maxWorkers, setMaxWorkers] = useState(
    project.max_workers != null ? String(project.max_workers) : "",
  );
  const updateProject = useUpdateProject();
  const { data: summary } = useProjectSummary(project.id);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const input: UpdateProjectInput & { id: string } = {
      id: project.id,
      name: name.trim(),
      description: description.trim() || null,
      status,
      tags: tags.trim()
        ? tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : null,
      scope: scope.trim() || null,
      max_workers: maxWorkers ? Number(maxWorkers) : null,
    };
    updateProject.mutate(input, {
      onSuccess: () => onClose(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        data-testid="edit-project-dialog"
        className="bg-surface border-outline-variant max-w-lg"
      >
        <DialogHeader>
          <DialogTitle className="font-headline text-base  text-on-surface">
            Edit Project
          </DialogTitle>
        </DialogHeader>

        {summary && <ProjectSummaryBar summary={summary} />}
        <Button
          type="button"
          data-testid="project-create-task"
          variant="outline"
          size="sm"
          onClick={() => onFirstTask(project.id)}
        >
          Create task in this project
        </Button>

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-sm  text-muted-foreground">Name *</Label>
            <Input
              aria-label="Name"
              data-testid="edit-project-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-background border-outline-variant text-on-surface font-body text-sm"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-sm  text-muted-foreground">Description</Label>
            <Textarea
              aria-label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="bg-background border-outline-variant text-on-surface font-body text-sm resize-none"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-sm  text-muted-foreground">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as ProjectStatus)}>
                <SelectTrigger
                  aria-label="Status"
                  className="bg-background border-outline-variant text-on-surface font-label text-sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-highest border-outline-variant">
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
                className="bg-background border-outline-variant text-on-surface font-body text-sm"
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
              className="bg-background border-outline-variant text-on-surface font-body text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-sm  text-muted-foreground">Scope</Label>
            <Input
              aria-label="Scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="bg-background border-outline-variant text-on-surface font-body text-sm"
            />
          </div>
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
              data-testid="edit-project-submit"
              type="submit"
              size="sm"
              disabled={updateProject.isPending || !name.trim()}
              className="font-label text-sm bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
            >
              {updateProject.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
          {updateProject.error && (
            <p role="alert" className="text-sm text-error">
              {updateProject.error.message}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectSummaryBar({ summary }: { summary: ProjectSummary }) {
  return (
    <div className="grid grid-cols-3 gap-4 p-3 bg-surface-highest/50 border border-outline-variant rounded-sm mt-2">
      <DetailField label="Tasks">
        <span className="font-label text-sm text-primary">{summary.tasks.total}</span>
        {Object.keys(summary.tasks.by_status).length > 0 && (
          <span className="text-muted-foreground text-sm ml-1">
            (
            {Object.entries(summary.tasks.by_status)
              .map(([s, n]) => `${n} ${s}`)
              .join(", ")}
            )
          </span>
        )}
      </DetailField>
      <DetailField label="Memories">
        <span className="font-label text-sm text-primary">{summary.memories}</span>
      </DetailField>
      <DetailField label="Jobs">
        <span className="font-label text-sm text-primary">{summary.jobs}</span>
      </DetailField>
    </div>
  );
}
