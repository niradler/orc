import { Link2, MessageSquare, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Task, TaskLinkType, TaskPriority, TaskStatus } from "@/api/client";
import { DetailField } from "@/components/DetailField";
import { PriorityBadge } from "@/components/PriorityBadge";
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
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useProjects } from "@/hooks/useProjects";
import {
  useAddTaskComment,
  useCreateTaskLink,
  useDeleteTaskLink,
  useTask,
  useTaskComments,
  useTaskLinks,
  useUpdateTask,
} from "@/hooks/useTasks";

const ALL_STATUSES: TaskStatus[] = ["todo", "doing", "review", "blocked", "done"];

const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "critical"];

const LINK_TYPES: TaskLinkType[] = [
  "blocks",
  "blocked_by",
  "relates_to",
  "duplicates",
  "clones",
  "subtask_of",
  "parent_of",
];

interface TaskDetailSheetProps {
  taskId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TaskDetailSheet({ taskId, open, onOpenChange }: TaskDetailSheetProps) {
  const { data: task, isLoading } = useTask(taskId);
  const { data: comments } = useTaskComments(taskId);
  const { data: links } = useTaskLinks(taskId);
  const { data: projects } = useProjects();
  const addComment = useAddTaskComment();
  const createLink = useCreateTaskLink();
  const deleteLink = useDeleteTaskLink();

  const [commentText, setCommentText] = useState("");
  const [commentAuthor, setCommentAuthor] = useState("human");
  const [showAddLink, setShowAddLink] = useState(false);
  const [linkToTaskId, setLinkToTaskId] = useState("");
  const [linkType, setLinkType] = useState<TaskLinkType>("relates_to");
  const [editing, setEditing] = useState(false);

  const handleAddComment = () => {
    if (!taskId || !commentText.trim()) return;
    addComment.mutate(
      { id: taskId, content: commentText.trim(), author: commentAuthor || "human" },
      {
        onSuccess: () => {
          setCommentText("");
        },
      },
    );
  };

  const handleAddLink = () => {
    if (!taskId || !linkToTaskId.trim()) return;
    createLink.mutate(
      { id: taskId, to_task_id: linkToTaskId.trim(), link_type: linkType },
      {
        onSuccess: () => {
          setLinkToTaskId("");
          setShowAddLink(false);
        },
      },
    );
  };

  const linksByType = useMemo(() => {
    if (!links) return {};
    return links.reduce(
      (acc, link) => {
        const key = link.link_type;
        if (!acc[key]) acc[key] = [];
        acc[key].push(link);
        return acc;
      },
      {} as Record<string, typeof links>,
    );
  }, [links]);

  const projectName = useMemo(() => {
    if (!task?.project_id || !projects) return null;
    return projects.find((p) => p.id === task.project_id)?.name ?? task.project_id.slice(-6);
  }, [task?.project_id, projects]);

  const formatDate = (d: string | null) => {
    if (!d) return "-";
    return new Date(d).toLocaleString();
  };

  const isOverdue = (d: string | null) => {
    if (!d) return false;
    return new Date(d) < new Date();
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetHeader>
            {isLoading ? (
              <Skeleton className="h-5 w-48 bg-surface-highest" />
            ) : task ? (
              <div className="space-y-2 pr-6">
                <SheetTitle>{task.title}</SheetTitle>
                <div className="flex items-center gap-2">
                  <StatusBadge status={task.status} />
                  <PriorityBadge priority={task.priority} />
                </div>
              </div>
            ) : (
              <SheetTitle>Task not found</SheetTitle>
            )}
          </SheetHeader>

          <SheetBody>
            {isLoading ? (
              <div className="space-y-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                  <Skeleton key={i} className="h-8 w-full bg-surface-highest" />
                ))}
              </div>
            ) : task ? (
              <div className="space-y-6">
                {task.body && (
                  <div className="space-y-1">
                    <div className="font-label text-[10px] uppercase tracking-widest text-outline">
                      Body
                    </div>
                    <div className="font-body text-xs text-on-surface whitespace-pre-wrap bg-surface-highest/50 p-3 rounded-sm border border-surface-highest">
                      {task.body}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <DetailField label="ID">
                    <span className="font-mono text-[10px]">{task.id}</span>
                  </DetailField>
                  <DetailField label="Author">{task.author}</DetailField>
                  <DetailField label="Claimed By">{task.claimed_by ?? "-"}</DetailField>
                  <DetailField label="Project">{projectName ?? "-"}</DetailField>
                  <DetailField label="Skill">{task.skill_name ?? "-"}</DetailField>
                  <DetailField label="Agent Backend">{task.agent_backend ?? "-"}</DetailField>
                  <DetailField label="Required Review">
                    {task.required_review ? "Yes" : "No"}
                  </DetailField>
                  <DetailField label="Max Review Rounds">{task.max_review_rounds}</DetailField>
                  <DetailField label="Due">
                    <span
                      className={
                        isOverdue(task.due_at) && task.status !== "done" ? "text-error" : ""
                      }
                    >
                      {formatDate(task.due_at)}
                    </span>
                  </DetailField>
                  <DetailField label="Created">{formatDate(task.created_at)}</DetailField>
                  <DetailField label="Updated">{formatDate(task.updated_at)}</DetailField>
                </div>

                {task.progress > 0 && (
                  <div className="space-y-1">
                    <div className="font-label text-[10px] uppercase tracking-widest text-outline">
                      Progress
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-surface-highest rounded-sm overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-sm transition-all"
                          style={{ width: `${Math.min(100, task.progress)}%` }}
                        />
                      </div>
                      <span className="font-label text-[10px] text-outline">{task.progress}%</span>
                    </div>
                  </div>
                )}

                {task.tags && task.tags.length > 0 && (
                  <div className="space-y-1">
                    <div className="font-label text-[10px] uppercase tracking-widest text-outline">
                      Tags
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {task.tags.map((tag) => (
                        <span
                          key={tag}
                          className="px-2 py-0.5 text-[10px] font-label uppercase tracking-wider bg-primary/10 text-primary border border-primary/20 rounded-sm"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="border-t border-surface-highest pt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-label text-[10px] uppercase tracking-widest text-outline">
                      <Link2 size={12} />
                      Links
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowAddLink(true)}
                      className="text-primary hover:text-primary/80 transition-colors"
                    >
                      <Plus size={14} />
                    </button>
                  </div>

                  {links && links.length > 0 ? (
                    <div className="space-y-2">
                      {Object.entries(linksByType).map(([type, typeLinks]) => (
                        <div key={type} className="space-y-1">
                          <div className="font-label text-[9px] uppercase tracking-widest text-outline/70">
                            {type.replace(/_/g, " ")}
                          </div>
                          {typeLinks.map((link) => (
                            <div
                              key={link.id}
                              className="flex items-center justify-between px-2 py-1 bg-surface-highest/50 rounded-sm"
                            >
                              <span className="font-mono text-[10px] text-on-surface-variant">
                                {link.from_task_id === taskId
                                  ? link.to_task_id.slice(-6)
                                  : link.from_task_id.slice(-6)}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  deleteLink.mutate({
                                    taskId: taskId as string,
                                    linkId: link.id,
                                  })
                                }
                                className="text-outline hover:text-error transition-colors p-0.5"
                              >
                                <Trash2 size={10} />
                              </button>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="font-body text-xs text-outline">No links</div>
                  )}

                  {showAddLink && (
                    <div className="space-y-2 p-2 bg-surface-highest/30 rounded-sm border border-surface-highest">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                            Link Type
                          </Label>
                          <Select
                            value={linkType}
                            onValueChange={(v) => setLinkType(v as TaskLinkType)}
                          >
                            <SelectTrigger className="bg-background border-surface-highest text-on-surface font-label text-xs h-7">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-surface-highest border-surface-highest">
                              {LINK_TYPES.map((lt) => (
                                <SelectItem key={lt} value={lt} className="font-label text-xs">
                                  {lt.replace(/_/g, " ")}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                            Target Task ID
                          </Label>
                          <Input
                            value={linkToTaskId}
                            onChange={(e) => setLinkToTaskId(e.target.value)}
                            placeholder="Task ID..."
                            className="bg-background border-surface-highest text-on-surface font-body text-xs h-7"
                          />
                        </div>
                      </div>
                      <div className="flex gap-2 justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setShowAddLink(false);
                            setLinkToTaskId("");
                          }}
                          className="font-label text-[10px] uppercase text-outline h-6 px-2"
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={handleAddLink}
                          disabled={createLink.isPending || !linkToTaskId.trim()}
                          className="font-label text-[10px] uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 h-6 px-2"
                        >
                          Add
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="border-t border-surface-highest pt-4 space-y-3">
                  <div className="flex items-center gap-1.5 font-label text-[10px] uppercase tracking-widest text-outline">
                    <MessageSquare size={12} />
                    Comments ({comments?.length ?? 0})
                  </div>

                  {comments && comments.length > 0 && (
                    <div className="space-y-2">
                      {comments.map((c) => (
                        <div
                          key={c.id}
                          className="p-2 bg-surface-highest/50 rounded-sm border border-surface-highest space-y-1"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-label text-[10px] uppercase tracking-wider text-primary">
                              {c.author}
                            </span>
                            <span className="font-label text-[9px] text-outline">
                              {new Date(c.created_at).toLocaleString()}
                            </span>
                          </div>
                          <div className="font-body text-xs text-on-surface whitespace-pre-wrap">
                            {c.content}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <Input
                        value={commentAuthor}
                        onChange={(e) => setCommentAuthor(e.target.value)}
                        placeholder="Author"
                        className="bg-background border-surface-highest text-on-surface font-body text-xs h-7 w-24"
                      />
                      <Textarea
                        value={commentText}
                        onChange={(e) => setCommentText(e.target.value)}
                        placeholder="Add a comment..."
                        className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none flex-1"
                        rows={2}
                      />
                    </div>
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        onClick={handleAddComment}
                        disabled={addComment.isPending || !commentText.trim()}
                        className="font-label text-[10px] uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 h-6 px-2"
                      >
                        {addComment.isPending ? "..." : "Comment"}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-outline font-label text-xs uppercase tracking-widest text-center py-8">
                Task not found
              </div>
            )}
          </SheetBody>

          {task && (
            <SheetFooter>
              <Button
                size="sm"
                onClick={() => setEditing(true)}
                className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
              >
                Edit Task
              </Button>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>

      {task && editing && (
        <EditTaskDialog task={task} open={editing} onClose={() => setEditing(false)} />
      )}
    </>
  );
}

function EditTaskDialog({
  task,
  open,
  onClose,
}: {
  task: Task;
  open: boolean;
  onClose: () => void;
}) {
  const { data: projects } = useProjects();
  const updateTask = useUpdateTask();

  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body ?? "");
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dueAt, setDueAt] = useState(task.due_at ?? "");
  const [tags, setTags] = useState((task.tags ?? []).join(", "));
  const [projectId, setProjectId] = useState(task.project_id ?? "");
  const [skillName, setSkillName] = useState(task.skill_name ?? "");
  const [agentBackend, setAgentBackend] = useState(task.agent_backend ?? "");
  const [requiredReview, setRequiredReview] = useState(task.required_review);
  const [maxReviewRounds, setMaxReviewRounds] = useState(String(task.max_review_rounds));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const parsedTags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    updateTask.mutate(
      {
        id: task.id,
        title: title.trim(),
        body: body.trim() || null,
        status,
        priority,
        due_at: dueAt || null,
        tags: parsedTags.length > 0 ? parsedTags : null,
        project_id: projectId || null,
        skill_name: skillName || null,
        agent_backend: agentBackend || null,
        required_review: requiredReview,
        max_review_rounds: Number(maxReviewRounds) || 3,
      },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            Edit Task
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
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Body
            </Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none"
              rows={4}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Status
              </Label>
              <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}>
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
              <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
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
                value={dueAt ? dueAt.slice(0, 16) : ""}
                onChange={(e) =>
                  setDueAt(e.target.value ? new Date(e.target.value).toISOString() : "")
                }
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
                Skill Name
              </Label>
              <Input
                value={skillName}
                onChange={(e) => setSkillName(e.target.value)}
                placeholder="e.g. code-review"
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Agent Backend
              </Label>
              <Input
                value={agentBackend}
                onChange={(e) => setAgentBackend(e.target.value)}
                placeholder="e.g. claude"
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 flex items-center gap-2 pt-4">
              <input
                type="checkbox"
                id="edit-required-review"
                checked={requiredReview}
                onChange={(e) => setRequiredReview(e.target.checked)}
                className="accent-primary"
              />
              <Label
                htmlFor="edit-required-review"
                className="font-label text-[10px] uppercase tracking-widest text-outline cursor-pointer"
              >
                Required Review
              </Label>
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
                Max Review Rounds
              </Label>
              <Input
                type="number"
                value={maxReviewRounds}
                onChange={(e) => setMaxReviewRounds(e.target.value)}
                min={1}
                className="bg-background border-surface-highest text-on-surface font-body text-xs"
              />
            </div>
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
              disabled={updateTask.isPending || !title.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
            >
              {updateTask.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
