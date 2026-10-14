import { LayoutGrid, List, MessageSquare, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Task, TaskPriority, TaskStatus } from "@/api/client";
import { KanbanBoard } from "@/components/board/KanbanBoard";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CreateTaskDialog } from "@/components/CreateTaskDialog";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { GithubBoard } from "@/components/GithubBoard";
import { PriorityBadge } from "@/components/PriorityBadge";
import { StatusBadge } from "@/components/StatusBadge";
import { TaskDetailSheet } from "@/components/TaskDetailSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ViewHeader } from "@/components/ViewHeader";
import { useDetailRoute } from "@/hooks/useDetailRoute";
import { useProjectScope } from "@/hooks/useProjectScope";
import { useDeleteTask, useTasks, useUpdateTask } from "@/hooks/useTasks";

const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "critical"];

const STATUS_TABS: Array<{ value: TaskStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "todo", label: "Todo" },
  { value: "doing", label: "Doing" },
  { value: "review", label: "Review" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

// Statuses exposed in the user-facing dropdown. Internal/edge statuses
// (queued, changes_requested, paused, cancelled) are still respected by the
// backend but are not surfaced as direct picks here.
const ALL_STATUSES: TaskStatus[] = ["todo", "doing", "review", "blocked", "done"];

const STATUS_VALUES = new Set<string>([
  "all",
  "todo",
  "queued",
  "doing",
  "review",
  "changes_requested",
  "blocked",
  "done",
  "cancelled",
  "paused",
]);

const PRIORITY_VALUES = new Set<string>(["all", "low", "normal", "high", "critical"]);

interface TasksProps {
  projectId: string;
}

export default function Tasks({ projectId: savedProjectId }: TasksProps) {
  const projectId = useProjectScope(savedProjectId);
  const [searchParams, setSearchParams] = useSearchParams();
  const pendingParams = useRef(searchParams);
  pendingParams.current = searchParams;
  const {
    selectedId: selectedTaskId,
    openDetail,
    closeDetail,
  } = useDetailRoute("/tasks", "taskId");

  const statusParam = searchParams.get("status");
  const statusFilter = (statusParam && STATUS_VALUES.has(statusParam) ? statusParam : "all") as
    | TaskStatus
    | "all";
  const statusTabs = STATUS_TABS.some(({ value }) => value === statusFilter)
    ? STATUS_TABS
    : [
        ...STATUS_TABS,
        {
          value: statusFilter,
          label: statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1).replace(/_/g, " "),
        },
      ];
  const priorityParam = searchParams.get("priority");
  const priorityFilter = (
    priorityParam && PRIORITY_VALUES.has(priorityParam) ? priorityParam : "all"
  ) as TaskPriority | "all";
  const search = searchParams.get("q") ?? "";
  const viewMode: "board" | "table" = searchParams.get("view") === "table" ? "table" : "board";

  const updateParam = useCallback(
    (key: string, value: string | null, defaultValue?: string) => {
      const next = new URLSearchParams(pendingParams.current);
      if (value === null || value === "" || value === defaultValue) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      if (next.toString() === pendingParams.current.toString()) return;
      pendingParams.current = next;
      setSearchParams(next, { replace: key === "q" });
    },
    [setSearchParams],
  );

  const setStatusFilter = (v: TaskStatus | "all") => updateParam("status", v, "all");
  const setPriorityFilter = (v: TaskPriority | "all") => updateParam("priority", v, "all");
  const setSearch = (v: string) => updateParam("q", v || null);
  const setViewMode = (v: "board" | "table") => updateParam("view", v, "board");

  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);

  const apiProjectId =
    projectId === "all" ? undefined : projectId === "unassigned" ? undefined : projectId;

  const {
    data: allTasks,
    isLoading,
    error,
    refetch,
  } = useTasks(apiProjectId ? { project_id: apiProjectId } : undefined);
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const filteredByProject = useMemo(() => {
    const tasks = allTasks ?? [];
    if (projectId === "unassigned") {
      return tasks.filter((t) => !t.project_id);
    }
    return tasks;
  }, [allTasks, projectId]);

  const visible = useMemo(() => {
    let result = filteredByProject;
    if (statusFilter !== "all") {
      result = result.filter((t) => t.status === statusFilter);
    }
    if (priorityFilter !== "all") {
      result = result.filter((t) => t.priority === priorityFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((t) => t.title.toLowerCase().includes(q));
    }
    return result;
  }, [filteredByProject, statusFilter, priorityFilter, search]);

  const counts = useMemo(
    () =>
      filteredByProject.reduce(
        (acc, t) => {
          acc[t.status] = (acc[t.status] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
    [filteredByProject],
  );

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteTask.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  };

  const isOverdue = (d: string | null, status: string) => {
    if (!d || status === "done" || status === "cancelled") return false;
    return new Date(d) < new Date();
  };

  if (error)
    return (
      <div>
        <ViewHeader title="Tasks" />
        <ErrorState message={error.message} onRetry={() => refetch()} />
      </div>
    );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ViewHeader
        title="Tasks"
        meta={`${filteredByProject.length} total`}
        action={
          <div className="flex items-center gap-2">
            <div className="flex border border-surface-highest rounded-lg overflow-hidden">
              <button
                type="button"
                data-testid="tasks-view-board"
                title="Board view"
                aria-label="Board view"
                aria-pressed={viewMode === "board"}
                onClick={() => setViewMode("board")}
                className={`p-3 transition-colors ${
                  viewMode === "board"
                    ? "bg-primary/15 text-primary"
                    : "text-outline hover:text-on-surface-variant"
                }`}
              >
                <LayoutGrid size={14} />
              </button>
              <button
                type="button"
                data-testid="tasks-view-table"
                title="Table view"
                aria-label="Table view"
                aria-pressed={viewMode === "table"}
                onClick={() => setViewMode("table")}
                className={`p-3 transition-colors ${
                  viewMode === "table"
                    ? "bg-primary/15 text-primary"
                    : "text-outline hover:text-on-surface-variant"
                }`}
              >
                <List size={14} />
              </button>
            </div>
            <Button
              data-testid="new-task-button"
              size="sm"
              onClick={() => setCreating(true)}
              className="font-label text-xs bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
            >
              <Plus size={14} className="mr-1" />
              New task
            </Button>
          </div>
        }
      />

      <GithubBoard projectId={apiProjectId} />
      {(updateTask.error || deleteTask.error) && (
        <p role="alert" className="mb-4 text-sm text-error">
          {(updateTask.error ?? deleteTask.error)?.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-outline" />
          <Input
            aria-label="Search tasks"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks..."
            className="bg-surface border-surface-highest text-on-surface font-body text-xs pl-8 min-h-11"
          />
        </div>
        <Select
          value={priorityFilter}
          onValueChange={(v) => setPriorityFilter(v as TaskPriority | "all")}
        >
          <SelectTrigger
            aria-label="Filter by priority"
            className="bg-surface border-surface-highest text-on-surface font-label text-xs w-36 min-h-11"
          >
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent className="bg-surface-highest border-surface-highest">
            <SelectItem value="all" className="font-label text-xs">
              All Priorities
            </SelectItem>
            {PRIORITIES.map((p) => (
              <SelectItem key={p} value={p} className="font-label text-xs">
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {viewMode === "board" ? (
        isLoading ? (
          <div role="status" aria-label="Loading tasks" className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
              <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
            ))}
          </div>
        ) : (
          <KanbanBoard
            tasks={visible}
            onUpdateStatus={(id, status) => updateTask.mutate({ id, status })}
            onDeleteTask={(id) => {
              const task = (allTasks ?? []).find((t) => t.id === id);
              if (task) setDeleteTarget(task);
            }}
            onCardClick={(task) => openDetail(task.id)}
          />
        )
      ) : (
        <Tabs
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as TaskStatus | "all")}
          className="mb-4"
        >
          <TabsList className="bg-background gap-1 h-auto p-0 flex-wrap justify-start">
            {statusTabs.map(({ value, label }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="font-label text-sm px-4 py-2 rounded-md
                    data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none
                    text-outline hover:text-on-surface-variant"
              >
                {label}
                {value !== "all" && counts[value] != null && (
                  <span className="ml-1.5 text-xs bg-surface-highest px-1.5 py-0.5 rounded-lg">
                    {counts[value]}
                  </span>
                )}
                {value === "all" && (
                  <span className="ml-1.5 text-xs bg-surface-highest px-1.5 py-0.5 rounded-lg">
                    {filteredByProject.length}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={statusFilter}>
            {isLoading ? (
              <div role="status" aria-label="Loading tasks" className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                  <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
                ))}
              </div>
            ) : visible.length === 0 ? (
              <EmptyState message="No tasks" />
            ) : (
              <div className="border border-surface-highest rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="border-b border-surface-highest hover:bg-transparent">
                      <TableHead className="font-label text-xs text-outline w-16">ID</TableHead>
                      <TableHead className="font-label text-xs text-outline">Title</TableHead>
                      <TableHead className="font-label text-xs text-outline w-40">Status</TableHead>
                      <TableHead className="font-label text-xs text-outline w-28">
                        Priority
                      </TableHead>
                      <TableHead className="font-label text-xs text-outline w-24">Tags</TableHead>
                      <TableHead className="font-label text-xs text-outline w-16" title="Comments">
                        <MessageSquare size={12} className="inline" />
                      </TableHead>
                      <TableHead className="font-label text-xs text-outline w-24">Due</TableHead>
                      <TableHead className="font-label text-xs text-outline w-24">Author</TableHead>
                      <TableHead className="font-label text-xs text-outline w-24">
                        Updated
                      </TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((task) => (
                      <TableRow
                        key={task.id}
                        data-testid="task-row"
                        data-task-id={task.id}
                        data-task-title={task.title}
                        className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                        onClick={() => openDetail(task.id)}
                      >
                        <TableCell className="font-label text-xs text-outline">
                          {task.id.slice(-6)}
                        </TableCell>
                        <TableCell className="font-body text-xs text-on-surface max-w-xs truncate">
                          <button
                            type="button"
                            className="text-left font-medium hover:text-primary"
                            onClick={(event) => {
                              event.stopPropagation();
                              openDetail(task.id);
                            }}
                          >
                            {task.title}
                          </button>
                        </TableCell>
                        <TableCell>
                          {/** biome-ignore lint/a11y/noStaticElementInteractions: event stopper wrapping an interactive Select */}
                          <div
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                            }}
                          >
                            <Select
                              value={task.status}
                              onValueChange={(v) =>
                                updateTask.mutate({
                                  id: task.id,
                                  status: v as TaskStatus,
                                })
                              }
                            >
                              <SelectTrigger
                                aria-label={`Status for ${task.title}`}
                                className="min-h-10 w-auto border-0 bg-transparent p-1 gap-1"
                              >
                                <SelectValue>
                                  <StatusBadge status={task.status} />
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent className="bg-surface-highest border-surface-highest">
                                {ALL_STATUSES.map((s) => (
                                  <SelectItem key={s} value={s} className="font-label text-xs">
                                    {s.replace(/_/g, " ")}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </TableCell>
                        <TableCell>
                          <PriorityBadge priority={task.priority} />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-0.5">
                            {task.tags && task.tags.length > 0 ? (
                              task.tags.slice(0, 2).map((tag) => (
                                <span
                                  key={tag}
                                  className="px-1.5 py-0.5 text-xs font-label bg-primary/10 text-primary border border-primary/20 rounded-lg"
                                >
                                  {tag}
                                </span>
                              ))
                            ) : (
                              <span className="text-outline text-xs">-</span>
                            )}
                            {task.tags && task.tags.length > 2 && (
                              <span className="text-outline text-xs">+{task.tags.length - 2}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell
                          className="font-label text-xs text-outline"
                          data-testid="task-comments-count"
                        >
                          {task.comments_count && task.comments_count > 0 ? (
                            <span className="inline-flex items-center gap-1">
                              <MessageSquare size={10} />
                              {task.comments_count}
                            </span>
                          ) : (
                            <span className="text-outline/50">-</span>
                          )}
                        </TableCell>
                        <TableCell
                          className={`font-label text-xs ${
                            isOverdue(task.due_at, task.status) ? "text-error" : "text-outline"
                          }`}
                        >
                          {task.due_at ? new Date(task.due_at).toLocaleDateString() : "-"}
                        </TableCell>
                        <TableCell className="font-label text-xs text-outline">
                          {task.author}
                        </TableCell>
                        <TableCell className="font-label text-xs text-outline">
                          {new Date(task.updated_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            data-testid="task-delete"
                            aria-label={`Delete ${task.title}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget(task);
                            }}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-outline hover:text-error hover:bg-error/10 transition-colors p-2"
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
      )}

      {creating && (
        <CreateTaskDialog
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={openDetail}
          defaultProjectId={
            projectId !== "all" && projectId !== "unassigned" ? projectId : undefined
          }
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Task"
        description={`Are you sure you want to delete "${deleteTarget?.title ?? ""}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        isPending={deleteTask.isPending}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <TaskDetailSheet
        taskId={selectedTaskId}
        open={selectedTaskId !== null}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
      />
    </div>
  );
}
