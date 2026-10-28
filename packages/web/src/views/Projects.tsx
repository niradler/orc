import { Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Project, ProjectStatus, ProjectSummary, UpdateProjectInput } from "@/api/client";
import { BulkActionBar } from "@/components/BulkActionBar";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CreateProjectDialog } from "@/components/CreateProjectDialog";
import { CreateTaskDialog } from "@/components/CreateTaskDialog";
import { DetailField } from "@/components/DetailField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { FormDialog } from "@/components/FormDialog";
import { ResponsiveFilters } from "@/components/ResponsiveFilters";
import { TaskDetailSheet } from "@/components/TaskDetailSheet";
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
import { useListSelection } from "@/hooks/useListSelection";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import {
  useDeleteProject,
  useProjectSummary,
  useProjects,
  useSetProjectsStatus,
  useUpdateProject,
} from "@/hooks/useProjects";
import { MEMORIES_PATH } from "@/lib/memory-routes";
import { PROJECT_STATUSES } from "@/lib/project-statuses";
import { useViewParam } from "@/lib/view-params";

const STATUS_TABS: Array<{ value: ProjectStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "paused", label: "Paused" },
];

export default function Projects() {
  const desktop = useBreakpoint("xl");
  const { data: projects, isLoading, error, refetch } = useProjects();
  const [query, setQuery] = useViewParam<string>("projectQuery", "");
  const [, setSearchParams] = useSearchParams();
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

  const matches = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (projects ?? []).filter(
      (project) =>
        !search ||
        `${project.name} ${project.description ?? ""} ${project.scope ?? ""} ${(project.tags ?? []).join(" ")}`
          .toLowerCase()
          .includes(search),
    );
  }, [projects, query]);
  const visible = useMemo(
    () => (filter === "all" ? matches : matches.filter((project) => project.status === filter)),
    [matches, filter],
  );
  const listScope = JSON.stringify([filter, query]);

  const selection = useListSelection(
    visible.map((project) => project.id),
    listScope,
  );
  const bulkUpdate = useSetProjectsStatus();
  const bulkResult = bulkUpdate.data?.scope === listScope ? bulkUpdate.data : undefined;

  async function setSelectedStatus(status: ProjectStatus): Promise<void> {
    const result = await bulkUpdate.mutateAsync({
      ids: selection.selectedIds,
      status,
      scope: listScope,
    });
    selection.select(result.failed.map((item) => item.id));
  }

  const counts = useMemo(() => {
    return matches.reduce(
      (acc, p) => {
        acc[p.status] = (acc[p.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
  }, [matches]);

  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Projects"
        meta={
          query || filter !== "all"
            ? `${visible.length} of ${(projects ?? []).length}`
            : (projects ?? []).length
        }
        action={
          <Button
            data-testid="new-project-button"
            size="sm"
            onClick={() => setCreating(true)}
            className="font-label text-sm  bg-primary text-primary-foreground hover:bg-primary/90"
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
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 lg:max-w-md">
            <Search
              size={14}
              aria-hidden
              className="absolute left-3 top-1/2 -translate-y-1/2 text-outline"
            />
            <Input
              type="search"
              data-testid="project-search"
              aria-label="Search projects"
              placeholder="Search projects…"
              value={query}
              onChange={(event) => setQuery(event.target.value, { replace: true })}
              className="pl-9"
            />
          </div>
          <ResponsiveFilters activeCount={Number(filter !== "all")}>
            <TabsList
              aria-label="Project status"
              className="bg-transparent gap-1 h-auto max-w-full flex-wrap justify-start p-0"
            >
              {STATUS_TABS.map(({ value, label }) => (
                <TabsTrigger
                  key={value}
                  data-testid={`projects-filter-${value}`}
                  value={value}
                  className="font-label text-[13px] px-3 py-1.5 rounded-md
                data-[state=active]:bg-surface-highest data-[state=active]:text-on-surface data-[state=active]:shadow-none
                text-muted-foreground hover:text-on-surface"
                >
                  {label}
                  {value !== "all" && counts[value] != null && (
                    <span className="ml-1.5 text-xs text-muted-foreground px-1.5 py-0.5">
                      {counts[value]}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </ResponsiveFilters>
        </div>
        {visible.length > 0 && (
          <BulkActionBar
            resourceLabel="projects"
            count={selection.selectedIds.length}
            allSelected={selection.allSelected}
            someSelected={selection.someSelected}
            onSelectAll={selection.selectAll}
            onClear={selection.clear}
            disabled={bulkUpdate.isPending}
          >
            {PROJECT_STATUSES.map((status) => (
              <Button
                key={status}
                type="button"
                size="sm"
                variant="outline"
                disabled={bulkUpdate.isPending}
                data-testid={`projects-bulk-${status}`}
                onClick={() => void setSelectedStatus(status)}
              >
                {status === "active" ? "Activate" : status === "paused" ? "Pause" : "Archive"}{" "}
                selected
              </Button>
            ))}
          </BulkActionBar>
        )}
        {bulkUpdate.isPending && (
          <p role="status" className="mb-3 text-sm text-outline">
            Updating selected projects...
          </p>
        )}
        {!bulkUpdate.isPending && bulkResult && (
          <div role="status" className="mb-3 space-y-1 text-sm" data-testid="projects-bulk-result">
            <p>
              {bulkResult.succeeded.length}{" "}
              {bulkResult.succeeded.length === 1 ? "project" : "projects"} set to{" "}
              {bulkResult.status}.
            </p>
            {bulkResult.failed.map((item) => (
              <p key={item.id} className="text-error">
                {projects?.find((project) => project.id === item.id)?.name ?? item.id}: {item.error}
                . Still selected for retry.
              </p>
            ))}
          </div>
        )}

        <TabsContent value={filter}>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <Skeleton key={i} className="h-12 w-full bg-surface-highest" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            query || filter !== "all" ? (
              <div
                data-testid="empty-state"
                className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-outline"
              >
                <p>No matching projects</p>
                <Button
                  variant="ghost"
                  data-testid="project-clear-filters"
                  onClick={() =>
                    setSearchParams((previous) => {
                      const next = new URLSearchParams(previous);
                      next.delete("projectQuery");
                      next.delete("status");
                      return next;
                    })
                  }
                >
                  Clear filters
                </Button>
              </div>
            ) : (
              <EmptyState message="No projects" />
            )
          ) : !desktop ? (
            <div className="divide-y divide-border">
              {visible.map((project) => (
                <article
                  key={project.id}
                  data-testid="project-row"
                  data-project-id={project.id}
                  data-project-name={project.name}
                  className="flex min-w-0 items-start gap-1 py-3"
                >
                  <label className="flex size-11 shrink-0 items-center justify-center">
                    <input
                      type="checkbox"
                      data-testid="project-select"
                      aria-label={`Select ${project.name}`}
                      className="size-4 accent-primary"
                      checked={selection.selectedIds.includes(project.id)}
                      disabled={bulkUpdate.isPending}
                      onChange={() => selection.toggle(project.id)}
                    />
                  </label>
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      data-testid="project-open"
                      aria-label={`Edit project: ${project.name}`}
                      className="min-h-11 w-full text-left text-sm font-medium wrap-break-word hover:text-primary"
                      onClick={() => openEdit(project.id)}
                    >
                      {project.name}
                    </button>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5 capitalize">
                        <span
                          aria-hidden
                          className={`size-1.5 rounded-full ${project.status === "active" ? "bg-secondary" : project.status === "paused" ? "bg-tertiary" : "bg-outline"}`}
                        />
                        {project.status}
                      </span>
                      {project.max_workers != null && <span>{project.max_workers} workers</span>}
                    </div>
                    {project.description && (
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground wrap-break-word">
                        {project.description}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid="project-delete"
                    aria-label={`Delete project: ${project.name}`}
                    onClick={() => setDeleting(project)}
                    className="shrink-0 text-muted-foreground hover:text-error"
                  >
                    <Trash2 size={14} />
                  </Button>
                </article>
              ))}
            </div>
          ) : (
            <div className="overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-outline-variant hover:bg-transparent">
                    <TableHead className="w-11">
                      <span className="sr-only">Select projects</span>
                    </TableHead>
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
                      Max workers
                    </TableHead>
                    <TableHead className="font-label text-sm  text-muted-foreground w-24">
                      Created
                    </TableHead>
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((p) => (
                    <TableRow
                      key={p.id}
                      data-testid="project-row"
                      data-project-id={p.id}
                      data-project-name={p.name}
                      className="border-b border-outline-variant/50 hover:bg-surface-high cursor-pointer"
                      onClick={() => openEdit(p.id)}
                    >
                      <TableCell>
                        <input
                          type="checkbox"
                          data-testid="project-select"
                          aria-label={`Select ${p.name}`}
                          className="size-4 accent-primary"
                          checked={selection.selectedIds.includes(p.id)}
                          disabled={bulkUpdate.isPending}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => selection.toggle(p.id)}
                        />
                      </TableCell>
                      <TableCell className="font-body text-sm font-medium text-on-surface">
                        <button
                          type="button"
                          className="min-h-8 text-left hover:text-primary"
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
                        <span className="inline-flex items-center gap-2 text-xs font-normal capitalize text-muted-foreground">
                          <span
                            aria-hidden="true"
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.status === "active" ? "bg-secondary" : p.status === "paused" ? "bg-tertiary" : "bg-outline"}`}
                          />
                          {p.status}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(p.tags ?? []).map((t) => (
                            <span
                              key={t}
                              className="font-label text-sm px-1.5 py-0.5 text-muted-foreground"
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
          description="This deletes the project, its memories and its scratchpads. Its tasks, jobs and sessions are kept without a project. This action cannot be undone."
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
  const [gitRemoteUrl, setGitRemoteUrl] = useState(project.git_remote_url ?? "");
  const [maxWorkers, setMaxWorkers] = useState(
    project.max_workers != null ? String(project.max_workers) : "",
  );
  const updateProject = useUpdateProject();
  const { data: summary } = useProjectSummary(project.id);
  const dirty =
    JSON.stringify([name, description, status, tags, scope, gitRemoteUrl, maxWorkers]) !==
    JSON.stringify([
      project.name,
      project.description ?? "",
      project.status,
      (project.tags ?? []).join(", "),
      project.scope ?? "",
      project.git_remote_url ?? "",
      project.max_workers != null ? String(project.max_workers) : "",
    ]);

  const handleSubmit = (e: React.FormEvent, closeAfterSave: () => void) => {
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
      git_remote_url: gitRemoteUrl.trim() || null,
      max_workers: maxWorkers ? Number(maxWorkers) : null,
    };
    updateProject.mutate(input, {
      onSuccess: closeAfterSave,
    });
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      dirty={dirty}
      busy={updateProject.isPending}
      testId="edit-project-dialog"
    >
      {(requestClose, closeAfterSave) => (
        <>
          <DialogHeader>
            <DialogTitle className="font-headline text-base  text-on-surface">
              Edit project
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={(event) => handleSubmit(event, closeAfterSave)} className="min-h-0">
            <div className="work-form-body grid grid-cols-1 gap-4 md:grid-cols-2">
              {summary && (
                <div className="md:col-span-2">
                  <ProjectSummaryBar summary={summary} allowNavigation={!dirty} />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 md:col-span-2">
                <Button
                  type="button"
                  data-testid="project-create-task"
                  variant="outline"
                  size="sm"
                  onClick={() => onFirstTask(project.id)}
                  disabled={dirty || updateProject.isPending}
                >
                  Create task in this project
                </Button>
                {dirty && (
                  <span className="text-xs text-muted-foreground">
                    Save changes before opening related work.
                  </span>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="font-label text-sm  text-muted-foreground">Name *</Label>
                <Input
                  aria-label="Name"
                  data-testid="edit-project-name-input"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
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
                  rows={2}
                  className="bg-background border-control-border text-on-surface font-body text-sm resize-none"
                />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:col-span-2">
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
              </div>
              <div className="space-y-1.5">
                <Label className="font-label text-sm  text-muted-foreground">
                  Tags (comma separated)
                </Label>
                <Input
                  aria-label="Tags (comma separated)"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  className="bg-background border-control-border text-on-surface font-body text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="font-label text-sm  text-muted-foreground">Scope</Label>
                <Input
                  aria-label="Scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  className="bg-background border-control-border text-on-surface font-body text-sm"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label
                  htmlFor="edit-project-git-remote-url"
                  className="font-label text-sm text-muted-foreground"
                >
                  Git remote URL (optional)
                </Label>
                <Input
                  id="edit-project-git-remote-url"
                  className="bg-background border-control-border text-on-surface font-body text-sm"
                  data-testid="edit-project-git-remote-url"
                  value={gitRemoteUrl}
                  onChange={(event) => setGitRemoteUrl(event.target.value)}
                  placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git"
                />
                <p className="text-xs text-muted-foreground">
                  Clear this field to remove the saved address.
                </p>
              </div>
              {updateProject.error && (
                <p role="alert" className="text-sm text-error md:col-span-2">
                  {updateProject.error.message}
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
              <Button
                data-testid="edit-project-submit"
                type="submit"
                size="sm"
                disabled={updateProject.isPending || !name.trim()}
                className="font-label text-sm bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {updateProject.isPending ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </>
      )}
    </FormDialog>
  );
}

function ProjectSummaryBar({
  summary,
  allowNavigation = true,
}: {
  summary: ProjectSummary;
  allowNavigation?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-4 py-3 border-t border-outline-variant mt-2">
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
        {allowNavigation ? (
          <Link
            data-testid="project-memories-link"
            to={`${MEMORIES_PATH}?project=${encodeURIComponent(summary.project.id)}`}
            className="font-label text-sm text-primary underline"
          >
            {summary.memories}
          </Link>
        ) : (
          <span className="font-label text-sm text-muted-foreground">{summary.memories}</span>
        )}
      </DetailField>
      <DetailField label="Jobs">
        <span className="font-label text-sm text-primary">{summary.jobs}</span>
      </DetailField>
    </div>
  );
}
