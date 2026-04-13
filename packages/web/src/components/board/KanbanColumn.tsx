import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Task, TaskStatus } from "@/api/client";
import { KanbanCard } from "./KanbanCard";

interface KanbanColumnProps {
  status: TaskStatus;
  label: string;
  color: string;
  tasks: Task[];
  onDeleteTask: (id: string) => void;
  isValidDrop: boolean | null;
}

export function KanbanColumn({
  status,
  label,
  color,
  tasks,
  onDeleteTask,
  isValidDrop,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status, data: { type: "column", status } });

  const taskIds = tasks.map((t) => t.id);

  let borderClass = "border-surface-highest";
  if (isValidDrop === true && isOver) {
    borderClass = "border-primary/60 bg-primary/5";
  } else if (isValidDrop === true) {
    borderClass = "border-primary/30";
  } else if (isValidDrop === false) {
    borderClass = "border-error/20 border-dashed opacity-50";
  }

  return (
    <div
      className={`
        flex flex-col min-w-[280px] max-w-[280px] h-full
        bg-surface-low/50 border rounded-sm
        transition-all duration-200
        ${borderClass}
      `}
    >
      <div className="flex-shrink-0 px-3 py-2.5 border-b border-surface-highest">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: color }}
            />
            <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant">
              {label}
            </span>
          </div>
          <span
            className="text-[10px] font-label px-1.5 py-0.5 rounded-sm
              bg-surface-highest text-outline"
          >
            {tasks.length}
          </span>
        </div>

        <div className="h-0.5 mt-2 rounded-full opacity-40" style={{ backgroundColor: color }} />
      </div>

      <div ref={setNodeRef} className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[100px]">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <KanbanCard key={task.id} task={task} onDelete={onDeleteTask} />
          ))}
        </SortableContext>

        {tasks.length === 0 && (
          <div className="flex items-center justify-center h-16 text-outline text-[10px] font-label uppercase tracking-widest">
            Empty
          </div>
        )}
      </div>
    </div>
  );
}
