import { useState } from "react";
import { useTasks, useCreateTask, useUpdateTask, useDeleteTask } from "@/hooks/useTasks";
import { ViewHeader } from "@/components/ViewHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { PriorityBadge } from "@/components/PriorityBadge";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2 } from "lucide-react";
import type { TaskPriority, TaskStatus } from "@/api/client";

const STATUS_TABS: Array<{ value: TaskStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "todo", label: "Todo" },
  { value: "doing", label: "Doing" },
  { value: "review", label: "Review" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

const ALL_STATUSES: TaskStatus[] = [
  "todo", "queued", "doing", "review", "changes_requested", "blocked", "done", "cancelled", "paused",
];

const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "critical"];

export default function Tasks() {
  const [filter, setFilter] = useState<TaskStatus | "all">("all");
  const [creating, setCreating] = useState(false);

  const { data: allTasks, isLoading, error, refetch } = useTasks();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const visible =
    filter === "all" ? (allTasks ?? []) : (allTasks ?? []).filter((t) => t.status === filter);

  const counts = (allTasks ?? []).reduce(
    (acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; },
    {} as Record<string, number>,
  );

  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Tasks"
        meta={`${(allTasks ?? []).length} total`}
        action={
          <Button size="sm" onClick={() => setCreating(true)}
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20">
            + New Task
          </Button>
        }
      />

      <Tabs value={filter} onValueChange={(v) => setFilter(v as TaskStatus | "all")} className="mb-4">
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
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-surface-highest" />)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState message="No tasks" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-16">ID</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Title</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-40">Status</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">Priority</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Author</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Updated</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((task) => (
                <TableRow key={task.id} className="border-b border-surface-highest/50 hover:bg-surface-low">
                  <TableCell className="font-label text-[10px] text-outline">{task.id.slice(-6)}</TableCell>
                  <TableCell className="font-body text-xs text-on-surface max-w-xs truncate">{task.title}</TableCell>
                  <TableCell>
                    <Select
                      value={task.status}
                      onValueChange={(v) => updateTask.mutate({ id: task.id, status: v as TaskStatus })}
                    >
                      <SelectTrigger className="h-6 w-auto border-0 bg-transparent p-0 focus:ring-0 gap-1">
                        <SelectValue>
                          <StatusBadge status={task.status} />
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="bg-surface-highest border-surface-highest">
                        {ALL_STATUSES.map((s) => (
                          <SelectItem key={s} value={s} className="font-label text-xs uppercase">
                            {s.replace(/_/g, " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell><PriorityBadge priority={task.priority} /></TableCell>
                  <TableCell className="font-label text-[10px] text-outline">{task.author}</TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {new Date(task.updated_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <button
                      onClick={() => deleteTask.mutate(task.id)}
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

      {creating && <CreateTaskDialog open={creating} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [status, setStatus] = useState<TaskStatus>("todo");

  const createTask = useCreateTask();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    createTask.mutate(
      { title: title.trim(), body: body.trim() || undefined, priority, status },
      { onSuccess: () => { setTitle(""); setBody(""); onClose(); } },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-md">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            New Task
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Title *</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Body</Label>
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
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-label text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-highest border-surface-highest">
                  {ALL_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="font-label text-xs">{s.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-label text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-highest border-surface-highest">
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p} className="font-label text-xs">{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}
              className="font-label text-xs uppercase text-outline">Cancel</Button>
            <Button type="submit" size="sm" disabled={createTask.isPending || !title.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25">
              {createTask.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
