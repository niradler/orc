import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useMemo, useState } from "react";
import type { Task, TaskStatus } from "@/api/client";
import { BOARD_COLUMNS, toVisibleStatus, type VisibleStatus } from "./board-utils";
import { KanbanCardOverlay } from "./KanbanCardOverlay";
import { KanbanColumn } from "./KanbanColumn";

interface KanbanBoardProps {
  tasks: Task[];
  onUpdateStatus: (id: string, status: TaskStatus) => void;
  onDeleteTask: (id: string) => void;
  onCardClick?: (task: Task) => void;
}

export function KanbanBoard({
  tasks,
  onUpdateStatus,
  onDeleteTask,
  onCardClick,
}: KanbanBoardProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const tasksByStatus = useMemo(() => {
    const map: Record<VisibleStatus, Task[]> = {
      todo: [],
      doing: [],
      review: [],
      blocked: [],
      done: [],
    };
    for (const task of tasks) {
      const visible = toVisibleStatus(task.status);
      if (visible) map[visible].push(task);
    }
    return map;
  }, [tasks]);

  function handleDragStart(event: DragStartEvent) {
    const task = event.active.data.current?.task as Task | undefined;
    if (task) setActiveTask(task);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) return;

    const task = active.data.current?.task as Task | undefined;
    if (!task) return;

    let targetStatus: VisibleStatus | undefined;

    if (over.data.current?.type === "column") {
      targetStatus = over.data.current.status as VisibleStatus;
    } else if (over.data.current?.type === "task") {
      const overTask = over.data.current.task as Task;
      const visible = toVisibleStatus(overTask.status);
      if (visible) targetStatus = visible;
    }

    if (!targetStatus) return;
    // Skip when card is dragged within the same visible column.
    if (toVisibleStatus(task.status) === targetStatus) return;

    onUpdateStatus(task.id, targetStatus);
  }

  // Trello-like: any column accepts any card. Highlight target on hover only.
  function getDropValidity(columnStatus: VisibleStatus): boolean | null {
    if (!activeTask) return null;
    if (toVisibleStatus(activeTask.status) === columnStatus) return null;
    return true;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex-1 min-h-0 flex gap-3 overflow-x-auto pb-4">
        {BOARD_COLUMNS.map((col) => (
          <KanbanColumn
            key={col.status}
            status={col.status}
            label={col.label}
            color={col.color}
            tasks={tasksByStatus[col.status]}
            onDeleteTask={onDeleteTask}
            onCardClick={onCardClick}
            isValidDrop={getDropValidity(col.status)}
          />
        ))}
      </div>

      <KanbanCardOverlay activeTask={activeTask} />
    </DndContext>
  );
}
