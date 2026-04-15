import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  CreateProjectInput,
  Project,
  ProjectStatus,
  ProjectSummary,
  TaskStatus,
  UpdateProjectInput,
} from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DetailField } from "@/components/DetailField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { StatusBadge } from "@/components/StatusBadge";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

const STATUS_TABS: Array<{ value: ProjectStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "paused", label: "Paused" },
];

const PROJECT_STATUSES: ProjectStatus[] = ["active", "archived", "paused"];

function projectStatusToTaskStatus(s: ProjectStatus): TaskStatus {
  if (s === "active") return "doing";
  if (s === "archived") return "done";
  return "paused";
}

export default function Projects() {
  const { data: projects, isLoading, error, refetch } = useProjects();
  const [filter, setFilter] = useState<ProjectStatus | "all">("all");
  const [creating, setCreating] = useState(false);
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
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
          >
            <Plus size={12} className="mr-1" />
            New Project
          </Button>
        }
      />

      <Tabs
        value={filter}
        onValueChange={(v) => setFilter(v as ProjectStatus | "all")}
        className="mb-4"
      >
        <TabsList className="bg-surface-highest border border-surface-highest gap-0 h-auto p-0">
          {STATUS_TABS.map(({ value, label }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="font-label text-[10px] uppercase tracking-widest px-4 py-2 rounded-none
                data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none
                text-outline hover:text-on-surface-variant"
            >
              {label}
              {value !== "all" && counts[value] != null && (
                <span className="ml-1.5 text-[9px] bg-surface-highest px-1.5 py-0.5 rounded-sm">
                  {counts[value]}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

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
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Name
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Description
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">
                  Status
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">
                  Tags
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Max Workers
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
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
                  className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                  onClick={() => openEdit(p.id)}
                >
                  <TableCell className="font-body text-xs font-semibold text-on-surface">
                    {p.name}
                  </TableCell>
                  <TableCell className="font-body text-xs text-outline max-w-xs truncate">
                    {p.description ?? "\u2014"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={projectStatusToTaskStatus(p.status)} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(p.tags ?? []).map((t) => (
                        <span
                          key={t}
                          className="font-label text-[9px] px-1.5 py-0.5 bg-surface-highest text-outline border border-surface-highest/50"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="font-label text-xs text-on-surface text-center">
                    {p.max_workers ?? "\u2014"}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {new Date(p.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      data-testid="project-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleting(p);
                      }}
                      className="text-outline hover:text-error transition-colors p-1"
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

      {creating && <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />}

      {editing && (
        <EditProjectDialog
          key={editing.id}
          open={Boolean(editing)}
          project={editing}
          onClose={closeEdit}
        />
      )}

      {deleting && (
        <ConfirmDialog
          open={Boolean(deleting)}
          title="Delete Project"
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

function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [tags, setTags] = useState("");
  const [scope, setScope] = useState("");
  const [maxWorkers, setMaxWorkers] = useState("");
  const createProject = useCreateProject();

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
      onSuccess: () => {
        onClose();
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-md">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            New Project
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Name *
            </Label>
            <Input
              data-testid="project-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="project-name"
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Description
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description..."
              rows={2}
              className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Status
              </Label>
              <Select value={status} onValueChange={(v) => setStatus(v as ProjectStatus)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-label text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-highest border-surface-highest">
                  {PROJECT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="font-label text-xs">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Max Workers
              </Label>
              <Input
                type="number"
                min={1}
                value={maxWorkers}
                onChange={(e) => setMaxWorkers(e.target.value)}
                placeholder="1"
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Tags (comma separated)
            </Label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="backend, api, v2"
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Scope
            </Label>
            <Input
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="Optional scope..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
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
              data-testid="project-submit"
              type="submit"
              size="sm"
              disabled={createProject.isPending || !name.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
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
}: {
  open: boolean;
  project: Project;
  onClose: () => void;
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
        className="bg-surface border-surface-highest max-w-lg"
      >
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            Edit Project
          </DialogTitle>
        </DialogHeader>

        {summary && <ProjectSummaryBar summary={summary} />}

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Name *
            </Label>
            <Input
              data-testid="edit-project-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Description
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Status
              </Label>
              <Select value={status} onValueChange={(v) => setStatus(v as ProjectStatus)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-label text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-highest border-surface-highest">
                  {PROJECT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="font-label text-xs">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Max Workers
              </Label>
              <Input
                type="number"
                min={1}
                value={maxWorkers}
                onChange={(e) => setMaxWorkers(e.target.value)}
                placeholder="1"
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Tags (comma separated)
            </Label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Scope
            </Label>
            <Input
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
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
              data-testid="edit-project-submit"
              type="submit"
              size="sm"
              disabled={updateProject.isPending || !name.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
            >
              {updateProject.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectSummaryBar({ summary }: { summary: ProjectSummary }) {
  return (
    <div className="grid grid-cols-3 gap-4 p-3 bg-surface-highest/50 border border-surface-highest rounded-sm mt-2">
      <DetailField label="Tasks">
        <span className="font-label text-xs text-primary">{summary.tasks.total}</span>
        {Object.keys(summary.tasks.by_status).length > 0 && (
          <span className="text-outline text-[10px] ml-1">
            (
            {Object.entries(summary.tasks.by_status)
              .map(([s, n]) => `${n} ${s}`)
              .join(", ")}
            )
          </span>
        )}
      </DetailField>
      <DetailField label="Memories">
        <span className="font-label text-xs text-primary">{summary.memories}</span>
      </DetailField>
      <DetailField label="Jobs">
        <span className="font-label text-xs text-primary">{summary.jobs}</span>
      </DetailField>
    </div>
  );
}
