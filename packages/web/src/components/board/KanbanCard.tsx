import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Trash2 } from "lucide-react";
import type { Task } from "@/api/client";
import { PRIORITY_COLORS } from "./board-utils";

interface KanbanCardProps {
  task: Task;
  onDelete: (id: string) => void;
  isDragOverlay?: boolean;
}

export function KanbanCard({ task, onDelete, isDragOverlay }: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: "task", task },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const accentColor = PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.normal;

  return (
    <div
      ref={isDragOverlay ? undefined : setNodeRef}
      style={isDragOverlay ? undefined : style}
      {...(isDragOverlay ? {} : attributes)}
      {...(isDragOverlay ? {} : listeners)}
      className={`
        group relative bg-surface-high border border-surface-highest rounded-sm
        cursor-grab active:cursor-grabbing
        hover:border-outline-variant hover:bg-surface-bright
        transition-colors duration-150
        ${isDragOverlay ? "shadow-lg shadow-primary/20 rotate-1 scale-105" : ""}
        ${task.priority === "critical" ? "animate-pulse-subtle" : ""}
      `}
    >
      {/* Priority accent stripe */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 rounded-l-sm"
        style={{ backgroundColor: accentColor }}
      />

      <div className="pl-3 pr-2 py-2">
        <p className="font-body text-xs text-on-surface line-clamp-2 leading-relaxed">
          {task.title}
        </p>

        <div className="flex items-center justify-between mt-2 gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="flex-shrink-0 w-4 h-4 rounded-sm bg-surface-highest
                text-[8px] font-label font-bold text-outline
                flex items-center justify-center uppercase"
            >
              {task.author?.[0] ?? "?"}
            </span>

            {task.tags?.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="text-[9px] font-label text-outline bg-surface-highest
                  px-1.5 py-0.5 rounded-sm truncate max-w-[60px]"
              >
                {tag}
              </span>
            ))}
          </div>

          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span className="text-[9px] font-label text-outline">
              {formatRelative(task.updated_at)}
            </span>

            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(task.id);
              }}
              className="opacity-0 group-hover:opacity-100 text-outline hover:text-error
                transition-opacity p-0.5"
            >
              <Trash2 size={10} />
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
