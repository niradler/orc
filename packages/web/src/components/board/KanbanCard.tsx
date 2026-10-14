import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, MessageSquare, Trash2 } from "lucide-react";
import { useRef } from "react";
import type { Task } from "@/api/client";
import { mappedStatusLabel, PRIORITY_COLORS } from "./board-utils";

interface KanbanCardProps {
  task: Task;
  onDelete: (id: string) => void;
  onClick?: (task: Task) => void;
  isDragOverlay?: boolean;
}

export function KanbanCard({ task, onDelete, onClick, isDragOverlay }: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useDraggable({
      id: task.id,
      data: { type: "task", task },
    });

  // Distinguish click from drag: only fire onClick if pointer barely moved.
  const downPos = useRef<{ x: number; y: number } | null>(null);

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.3 : 1,
  };

  const accentColor = PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.normal;
  // `queued` sits in Todo and `paused` in Blocked - say so on the card rather
  // than letting the column silently rename the task's real status.
  const statusLabel = mappedStatusLabel(task.status);

  // Chain our click-detection with dnd-kit's drag listeners so we don't clobber them.
  const dragPointerDown = listeners?.onPointerDown as
    | ((e: React.PointerEvent<HTMLDivElement>) => void)
    | undefined;
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    downPos.current = { x: e.clientX, y: e.clientY };
    dragPointerDown?.(e);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onClick || !downPos.current) return;
    const dx = Math.abs(e.clientX - downPos.current.x);
    const dy = Math.abs(e.clientY - downPos.current.y);
    downPos.current = null;
    // Pointer moved <5px: treat as click. Drag activates at 5px (PointerSensor distance).
    if (dx < 5 && dy < 5) onClick(task);
  };

  // Spread dnd-kit listeners but override pointerDown with our chained version.
  const dragListeners = isDragOverlay ? {} : { onPointerDown: handlePointerDown };

  return (
    <div
      ref={isDragOverlay ? undefined : setNodeRef}
      style={isDragOverlay ? undefined : style}
      data-testid="kanban-card"
      data-task-id={task.id}
      data-task-status={task.status}
      {...dragListeners}
      onPointerUp={isDragOverlay ? undefined : handlePointerUp}
      className={`
        group relative bg-surface border border-border rounded-lg
        cursor-grab active:cursor-grabbing
        hover:border-outline-variant hover:bg-surface-bright
        transition-colors duration-150
        ${isDragOverlay ? "shadow-lg shadow-primary/20 rotate-1 scale-105" : ""}
      `}
    >
      {/* Priority accent stripe */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 rounded-l-sm"
        style={{ backgroundColor: accentColor }}
      />

      <div className="pl-4 pr-3 py-4">
        <button
          type="button"
          aria-label={`Open task: ${task.title}`}
          onClick={(event) => {
            // Pointer clicks are handled by the card's drag/click discriminator.
            // Native keyboard activation has no pointer event and a zero click detail.
            if (event.detail === 0) onClick?.(task);
          }}
          className="w-full text-left font-body text-sm text-on-surface line-clamp-2 leading-relaxed hover:text-primary"
        >
          {task.title}
        </button>
        {(task.git_branch || task.github_issue || task.github_pr) && (
          <p data-testid="task-git-badge" className="text-xs text-primary truncate">
            {task.git_branch}
            {task.github_issue && ` · Issue #${task.github_issue.split("/").pop()}`}
            {task.github_pr && ` · PR #${task.github_pr.split("/").pop()}`}
          </p>
        )}

        <div className="flex items-center justify-between mt-2 gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="flex-shrink-0 w-4 h-4 rounded-lg bg-surface-highest
                text-[8px] font-label font-bold text-outline
                flex items-center justify-center"
            >
              {task.author?.[0] ?? "?"}
            </span>

            {statusLabel && (
              <span
                data-testid="kanban-card-status"
                className="text-xs font-label text-on-surface-variant
                  bg-surface-highest px-1.5 py-0.5 rounded-lg flex-shrink-0"
              >
                {statusLabel}
              </span>
            )}

            {task.tags?.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="text-xs font-label text-outline bg-surface-highest
                  px-1.5 py-0.5 rounded-lg truncate max-w-[60px]"
              >
                {tag}
              </span>
            ))}
          </div>

          <div className="flex items-center gap-1.5 flex-shrink-0">
            {!isDragOverlay && (
              <button
                type="button"
                ref={setActivatorNodeRef}
                {...attributes}
                onKeyDown={(event) => listeners?.onKeyDown?.(event)}
                aria-label={`Move task: ${task.title}`}
                title="Move task with Space, arrow keys, then Space to drop"
                onPointerUp={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                className="inline-flex min-h-11 min-w-11 md:min-h-8 md:min-w-8 items-center justify-center rounded text-outline hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              >
                <GripVertical size={14} />
              </button>
            )}
            {task.comments_count != null && task.comments_count > 0 && (
              <span
                className="flex items-center gap-0.5 text-xs font-label text-outline"
                title={`${task.comments_count} comment${task.comments_count === 1 ? "" : "s"}`}
              >
                <MessageSquare size={9} />
                {task.comments_count}
              </span>
            )}
            <span className="text-xs font-label text-outline">
              {formatRelative(task.updated_at)}
            </span>

            <button
              type="button"
              aria-label={`Delete task: ${task.title}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(task.id);
              }}
              className="opacity-100 md:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-outline hover:text-error
                transition-opacity min-h-11 min-w-11 md:min-h-8 md:min-w-8 inline-flex items-center justify-center"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}
