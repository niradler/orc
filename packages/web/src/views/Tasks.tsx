import { useState, useMemo } from "react";
import {
  useTasks,
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
} from "@/hooks/useTasks";
import { useProjects } from "@/hooks/useProjects";
import { ViewHeader } from "@/components/ViewHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { PriorityBadge } from "@/components/PriorityBadge";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Search, Plus } from "lucide-react";
import type {
  Task,
  TaskPriority,
  TaskStatus,
  CreateTaskInput,
} from "@/api/client";

const STATUS_TABS: Array<{ value: TaskStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "todo", label: "Todo" },
  { value: "queued", label: "Queued" },
  { value: "doing", label: "Doing" },
  { value: "review", label: "Review" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

const ALL_STATUSES: TaskStatus[] = [
  "todo",
  "queued",
  "doing",
  "review",
  "changes_requested",
  "blocked",
  "done",
  "cancelled",
  "paused",
];

const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "critical"];

interface TasksProps {
  projectId: string;
}

export default function Tasks({ projectId }: TasksProps) {
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "all">(
    "all",
  );
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const apiProjectId =
    projectId === "all" ? undefined : projectId === "unassigned" ? undefined : projectId;

  const { data: allTasks, isLoading, error, refetch } = useTasks(
    apiProjectId ? { project_id: apiProjectId } : undefined,
  );
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

  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Tasks"
        meta={`${filteredByProject.length} total`}
        action={
          <Button
            size="sm"
            onClick={() => setCreating(true)}
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
          >
            <Plus size={14} className="mr-1" />
            New Task
          </Button>
        }
      />

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-outline"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks..."
            className="bg-surface border-surface-highest text-on-surface font-body text-xs pl-8 h-8"
          />
        </div>
        <Select
          value={priorityFilter}
          onValueChange={(v) => setPriorityFilter(v as TaskPriority | "all")}
        >
          <SelectTrigger className="bg-surface border-surface-highest text-on-surface font-label text-[10px] uppercase tracking-widest w-32 h-8">
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent className="bg-surface-highest border-surface-highest">
            <SelectItem
              value="all"
              className="font-label text-xs uppercase"
            >
              All Priorities
            </SelectItem>
            {PRIORITIES.map((p) => (
              <SelectItem
                key={p}
                value={p}
                className="font-label text-xs uppercase"
              >
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Tabs
        value={statusFilter}
        onValueChange={(v) => setStatusFilter(v as TaskStatus | "all")}
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
              {value === "all" && (
                <span className="ml-1.5 text-[9px] bg-surface-highest px-1.5 py-0.5 rounded-sm">
                  {filteredByProject.length}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState message="No tasks" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-16">
                  ID
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Title
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-40">
                  Status
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">
                  Priority
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Tags
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Due
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Author
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Updated
                </TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((task) => (
                <TableRow
                  key={task.id}
                  className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                  onClick={() => setSelectedTaskId(task.id)}
                >
                  <TableCell className="font-label text-[10px] text-outline">
                    {task.id.slice(-6)}
                  </TableCell>
                  <TableCell className="font-body text-xs text-on-surface max-w-xs truncate">
                    {task.title}
                  </TableCell>
                  <TableCell>
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
                        <SelectTrigger className="h-6 w-auto border-0 bg-transparent p-0 focus:ring-0 gap-1">
                          <SelectValue>
                            <StatusBadge status={task.status} />
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent className="bg-surface-highest border-surface-highest">
                          {ALL_STATUSES.map((s) => (
                            <SelectItem
                              key={s}
                              value={s}
                              className="font-label text-xs uppercase"
                            >
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
                      {task.tags && task.tags.length > 0
                        ? task.tags.slice(0, 2).map((tag) => (
                            <span
                              key={tag}
                              className="px-1.5 py-0.5 text-[9px] font-label uppercase tracking-wider bg-primary/10 text-primary border border-primary/20 rounded-sm"
                            >
                              {tag}
                            </span>
                          ))
                        : <span className="text-outline text-[10px]">-</span>}
                      {task.tags && task.tags.length > 2 && (
                        <span className="text-outline text-[9px]">
                          +{task.tags.length - 2}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell
                    className={`font-label text-[10px] ${
                      isOverdue(task.due_at, task.status)
                        ? "text-error"
                        : "text-outline"
                    }`}
                  >
                    {task.due_at
                      ? new Date(task.due_at).toLocaleDateString()
                      : "-"}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {task.author}
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {new Date(task.updated_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(task);
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

      {creating && (
        <CreateTaskDialog
          open={creating}
          onClose={() => setCreating(false)}
          defaultProjectId={
            projectId !== "all" && projectId !== "unassigned"
              ? projectId
              : undefined
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
          if (!open) setSelectedTaskId(null);
        }}
      />
    </div>
  );
}

function CreateTaskDialog({
  open,
  onClose,
  defaultProjectId,
}: {
  open: boolean;
  onClose: () => void;
  defaultProjectId?: string;
}) {
  const { data: projects } = useProjects();
  const createTask = useCreateTask();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [status, setStatus] = useState<TaskStatus>("todo");
  const [dueAt, setDueAt] = useState("");
  const [tags, setTags] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [author, setAuthor] = useState("");
  const [skillName, setSkillName] = useState("");
  const [agentBackend, setAgentBackend] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const parsedTags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const input: CreateTaskInput = {
      title: title.trim(),
      body: body.trim() || undefined,
      priority,
      status: status as CreateTaskInput["status"],
      due_at: dueAt ? new Date(dueAt).toISOString() : undefined,
      tags: parsedTags.length > 0 ? parsedTags : undefined,
      project_id: projectId || undefined,
      author: author.trim() || undefined,
      skill_name: skillName.trim() || undefined,
      agent_backend: agentBackend.trim() || undefined,
    };
    createTask.mutate(input, {
      onSuccess: () => {
        setTitle("");
        setBody("");
        setPriority("normal");
        setStatus("todo");
        setDueAt("");
        setTags("");
        setAuthor("");
        setSkillName("");
        setAgentBackend("");
        onClose();
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            New Task
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Title *
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Body
            </Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Optional description..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Status
              </Label>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as TaskStatus)}
              >
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-label text-xs">
                  <SelectValue />
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
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Priority
              </Label>
              <Select
                value={priority}
                onValueChange={(v) => setPriority(v as TaskPriority)}
              >
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-label text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-highest border-surface-highest">
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p} className="font-label text-xs">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Due At
              </Label>
              <Input
                type="datetime-local"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Project
              </Label>
              <Select
                value={projectId || "__none__"}
                onValueChange={(v) => setProjectId(v === "__none__" ? "" : v)}
              >
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-label text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-highest border-surface-highest">
                  <SelectItem value="__none__" className="font-label text-xs">
                    None
                  </SelectItem>
                  {projects?.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="font-label text-xs">
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Tags (comma-separated)
            </Label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="tag1, tag2"
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Author
              </Label>
              <Input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="e.g. human"
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Skill Name
              </Label>
              <Input
                value={skillName}
                onChange={(e) => setSkillName(e.target.value)}
                placeholder="e.g. code-review"
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Agent Backend
            </Label>
            <Input
              value={agentBackend}
              onChange={(e) => setAgentBackend(e.target.value)}
              placeholder="e.g. claude, acpx, a2a"
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
              type="submit"
              size="sm"
              disabled={createTask.isPending || !title.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
            >
              {createTask.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
