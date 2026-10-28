import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { ErrorState } from "@/components/ErrorState";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function TaskPicker({
  projectId,
  pending,
  onSelect,
}: {
  projectId: string | null;
  pending: boolean;
  onSelect: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tasks = useQuery({
    queryKey: ["tasks", "session-picker", projectId],
    queryFn: () => api.tasks.list({ ...(projectId ? { project_id: projectId } : {}), limit: 100 }),
  });
  async function select(id: string): Promise<void> {
    setError(null);
    try {
      await onSelect(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not link task");
    }
  }
  async function lookup(): Promise<void> {
    setLookingUp(true);
    setError(null);
    try {
      const task = await api.tasks.get(query.trim());
      await select(task.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Task lookup failed");
    } finally {
      setLookingUp(false);
    }
  }
  const choices = (tasks.data?.tasks ?? []).filter((task) =>
    `${task.title} ${task.id}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className="space-y-3">
      <Input
        data-testid="session-task-search"
        aria-label="Search tasks or enter a task ID"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setError(null);
        }}
        placeholder="Search recent tasks or paste a task ID"
      />
      <p className="text-xs text-outline">
        Up to 100 recent tasks{projectId ? " in this project" : " across projects"}. Older or
        other-project tasks can be linked by exact ID.
      </p>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {tasks.error ? (
        <ErrorState message={tasks.error.message} onRetry={() => tasks.refetch()} />
      ) : tasks.isLoading ? (
        <p role="status">Loading tasks…</p>
      ) : (
        <div className="max-h-72 overflow-y-auto divide-y divide-border">
          {choices.map((task) => (
            <button
              key={task.id}
              type="button"
              data-testid="session-task-option"
              data-task-id={task.id}
              disabled={pending || lookingUp}
              onClick={() => void select(task.id)}
              className="w-full min-h-11 py-2 text-left hover:bg-surface-highest disabled:opacity-50"
            >
              <span className="block text-sm wrap-break-word">{task.title}</span>
              <span className="inline-flex items-center gap-2 text-xs text-outline">
                <StatusBadge status={task.status} className="px-0" />
                {task.id}
              </span>
            </button>
          ))}
          {choices.length === 0 && (
            <p className="py-4 text-sm text-outline">
              No recent task matches. Paste its exact ID to look it up.
            </p>
          )}
        </div>
      )}
      {query.trim() && (
        <Button variant="outline" disabled={pending || lookingUp} onClick={() => void lookup()}>
          {lookingUp ? "Looking up…" : "Link by exact ID"}
        </Button>
      )}
    </div>
  );
}
