import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type CreateTaskInput, type TaskPriority, type TaskStatus } from "@/api/client";
import { BackendPicker, USE_DEFAULT_BACKEND } from "@/components/BackendPicker";
import { FlowPicker, USE_DEFAULT_FLOW } from "@/components/flow/FlowPicker";
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
import { useBackends } from "@/hooks/useBackends";
import { useFlows } from "@/hooks/useFlows";
import { useProjects } from "@/hooks/useProjects";
import { useCreateTask } from "@/hooks/useTasks";

const ALL_STATUSES: TaskStatus[] = ["todo", "doing", "review", "blocked", "done"];
const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "critical"];

export function CreateTaskDialog({
  open,
  onClose,
  defaultProjectId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  defaultProjectId?: string;
  onCreated?: (id: string) => void;
}) {
  const { data: projects } = useProjects();
  const createTask = useCreateTask();
  const queryClient = useQueryClient();
  const { data: backends } = useBackends();
  const { data: flows } = useFlows();
  const [savedId, setSavedId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [launchError, setLaunchError] = useState("");

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [status, setStatus] = useState<TaskStatus>("todo");
  const [dueAt, setDueAt] = useState("");
  const [tags, setTags] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [author, setAuthor] = useState("");
  const [skillName, setSkillName] = useState("");
  const [agentBackend, setAgentBackend] = useState(USE_DEFAULT_BACKEND);
  const [flowName, setFlowName] = useState(USE_DEFAULT_FLOW);
  const backendName =
    agentBackend === USE_DEFAULT_BACKEND ? backends?.default_backend : agentBackend;
  const selectedFlow = flowName === USE_DEFAULT_FLOW ? flows?.default_flow : flowName;
  const project = projects?.find((item) => item.id === projectId);
  const ready = Boolean(
    status === "todo" &&
      project?.scope?.trim() &&
      backends?.backends.some((item) => item.name === backendName && item.available) &&
      flows?.flows.some((item) => item.name === selectedFlow),
  );

  const handleSubmit = async (e: React.FormEvent, start = false) => {
    e.preventDefault();
    if (!title.trim() || starting || (start && !ready)) return;
    setLaunchError("");
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
      ...(agentBackend === USE_DEFAULT_BACKEND ? {} : { agent_backend: agentBackend }),
      // Omitted, not null: no flow_name means "run the configured default".
      ...(flowName === USE_DEFAULT_FLOW ? {} : { flow_name: flowName }),
    };
    setStarting(start);
    try {
      const id = savedId ?? (await createTask.mutateAsync(input)).id;
      setSavedId(id);
      if (start && selectedFlow) {
        const result = await api.tasks.startFlow(id, selectedFlow);
        if (!result.started) throw new Error(result.error ?? "Workflow could not start");
      }
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      onClose();
      onCreated?.(id);
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm font-medium text-on-surface">
            New task
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4 mt-2">
          <p className="text-xs text-outline" data-testid="task-onboarding-hint">
            Choose a project folder, describe the result and acceptance checks, then preview a
            workflow. Built-in workflows include implementation and review skills automatically.
          </p>
          {savedId && (
            <p data-testid="task-saved-hint" className="text-xs text-outline">
              Task saved. Retry start or open it from Tasks.
            </p>
          )}
          <fieldset
            disabled={Boolean(savedId) || starting || createTask.isPending}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Title *</Label>
              <Input
                aria-label="Title"
                data-testid="task-title-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title..."
                className="bg-background border-surface-highest text-on-surface font-body text-sm"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-xs font-medium text-outline">Body</Label>
              <Textarea
                aria-label="Body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                data-testid="task-body-input"
                placeholder="Expected result, acceptance checks and constraints..."
                className="bg-background border-surface-highest text-on-surface font-body text-sm resize-none"
                rows={3}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="font-label text-xs font-medium text-outline">Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}>
                  <SelectTrigger
                    aria-label="Status"
                    className="bg-background border-surface-highest text-on-surface font-label text-xs"
                  >
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
                <Label className="font-label text-xs font-medium text-outline">Priority</Label>
                <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
                  <SelectTrigger
                    aria-label="Priority"
                    className="bg-background border-surface-highest text-on-surface font-label text-xs"
                  >
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="font-label text-xs font-medium text-outline">Due date</Label>
                <Input
                  aria-label="Due date"
                  type="datetime-local"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                  className="bg-background border-surface-highest text-on-surface font-body text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="font-label text-xs font-medium text-outline">Project</Label>
                <Select
                  value={projectId || "__none__"}
                  onValueChange={(v) => setProjectId(v === "__none__" ? "" : v)}
                >
                  <SelectTrigger
                    aria-label="Project"
                    data-testid="new-task-project"
                    className="bg-background border-surface-highest text-on-surface font-label text-xs"
                  >
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
              <Label className="font-label text-xs font-medium text-outline">
                Tags (comma-separated)
              </Label>
              <Input
                aria-label="Tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="tag1, tag2"
                className="bg-background border-surface-highest text-on-surface font-body text-sm"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="font-label text-xs font-medium text-outline">Author</Label>
                <Input
                  aria-label="Author"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="e.g. human"
                  className="bg-background border-surface-highest text-on-surface font-body text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="font-label text-xs font-medium text-outline">
                  Skill override (optional)
                </Label>
                <Input
                  aria-label="Skill override"
                  value={skillName}
                  onChange={(e) => setSkillName(e.target.value)}
                  placeholder="Use workflow skills"
                  className="bg-background border-surface-highest text-on-surface font-body text-sm"
                />
              </div>
            </div>
            <BackendPicker
              value={agentBackend}
              onChange={setAgentBackend}
              testId="new-task-backend"
            />
            <FlowPicker value={flowName} onChange={setFlowName} testId="new-task-flow" />
          </fieldset>
          <p data-testid="task-start-readiness" className="text-xs text-outline">
            {ready
              ? `Starts in ${project?.scope}. Track progress and human decisions in the task.`
              : "To start, select a project with a folder, a ready backend/workflow and Todo status. You can still save the task."}
          </p>
          {launchError && (
            <p role="alert" data-testid="task-create-error" className="text-xs text-destructive">
              {launchError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="font-label text-xs text-outline"
            >
              Cancel
            </Button>
            <Button
              data-testid="task-submit"
              type="submit"
              size="sm"
              disabled={createTask.isPending || starting || Boolean(savedId) || !title.trim()}
              className="font-label text-xs bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
            >
              {createTask.isPending ? "Creating..." : "Create"}
            </Button>
            <Button
              type="button"
              data-testid="task-create-start"
              size="sm"
              disabled={!ready || !title.trim() || createTask.isPending || starting}
              onClick={(event) => void handleSubmit(event, true)}
            >
              {starting ? "Starting…" : savedId ? "Retry start" : "Create and start"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
