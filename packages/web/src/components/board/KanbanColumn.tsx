import { useDroppable } from "@dnd-kit/core";
import type { Task, TaskStatus } from "@/api/client";
import { KanbanCard } from "./KanbanCard";

interface KanbanColumnProps {
  status: TaskStatus;
  label: string;
  color: string;
  tasks: Task[];
  onDeleteTask: (id: string) => void;
  onCardClick?: (task: Task) => void;
  isValidDrop: boolean | null;
}

export function KanbanColumn({
  status,
  label,
  color,
  tasks,
  onDeleteTask,
  onCardClick,
  isValidDrop,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: status,
    data: { type: "column", status },
  });

  let borderClass = "border-transparent";
  if (isValidDrop === true && isOver) {
    borderClass = "border-outline bg-surface-high";
  } else if (isValidDrop === true) {
    borderClass = "border-border";
  } else if (isValidDrop === false) {
    borderClass = "border-error border-dashed";
  }

  return (
    <div
      className={`
        flex flex-col w-full md:min-w-[260px] md:max-w-[300px] md:flex-1
        bg-background border rounded-lg
        transition-all duration-200
        ${borderClass}
      `}
    >
      <div className="flex-shrink-0 px-3 py-2.5 border-b border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: color }}
            />
            <span className="font-label text-sm font-medium text-on-surface-variant">{label}</span>
          </div>
          <span
            className="text-[11px] font-label px-1.5 py-0.5 rounded-sm
              text-outline"
          >
            {tasks.length}
          </span>
        </div>
      </div>

      <div
        ref={setNodeRef}
        data-testid="kanban-column"
        data-column-status={status}
        data-drop-target={isOver}
        className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[100px]"
      >
        {tasks.map((task) => (
          <KanbanCard key={task.id} task={task} onDelete={onDeleteTask} onClick={onCardClick} />
        ))}

        {tasks.length === 0 && (
          <div className="flex items-center justify-center h-16 text-outline text-sm font-label">
            Empty
          </div>
        )}
      </div>
    </div>
  );
}
