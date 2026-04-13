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
import { BOARD_COLUMNS, canTransition, validTargets } from "./board-utils";
import { KanbanCardOverlay } from "./KanbanCardOverlay";
import { KanbanColumn } from "./KanbanColumn";

interface KanbanBoardProps {
  tasks: Task[];
  onUpdateStatus: (id: string, status: TaskStatus) => void;
  onDeleteTask: (id: string) => void;
}

export function KanbanBoard({ tasks, onUpdateStatus, onDeleteTask }: KanbanBoardProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const tasksByStatus = useMemo(() => {
    const map: Record<TaskStatus, Task[]> = {
      todo: [],
      queued: [],
      doing: [],
      review: [],
      changes_requested: [],
      blocked: [],
      done: [],
      paused: [],
      cancelled: [],
    };
    for (const task of tasks) {
      map[task.status]?.push(task);
    }
    return map;
  }, [tasks]);

  const validDropStatuses = useMemo(() => {
    if (!activeTask) return null;
    return new Set(validTargets(activeTask.status));
  }, [activeTask]);

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

    let targetStatus: TaskStatus | undefined;

    if (over.data.current?.type === "column") {
      targetStatus = over.data.current.status as TaskStatus;
    } else if (over.data.current?.type === "task") {
      const overTask = over.data.current.task as Task;
      targetStatus = overTask.status;
    }

    if (!targetStatus) return;
    if (targetStatus === task.status) return;
    if (!canTransition(task.status, targetStatus)) return;

    onUpdateStatus(task.id, targetStatus);
  }

  function getDropValidity(columnStatus: TaskStatus): boolean | null {
    if (!activeTask) return null;
    if (activeTask.status === columnStatus) return null;
    return canTransition(activeTask.status, columnStatus);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-4 h-[calc(100vh-160px)]">
        {BOARD_COLUMNS.map((col) => (
          <KanbanColumn
            key={col.status}
            status={col.status}
            label={col.label}
            color={col.color}
            tasks={tasksByStatus[col.status]}
            onDeleteTask={onDeleteTask}
            isValidDrop={getDropValidity(col.status)}
          />
        ))}
      </div>

      <KanbanCardOverlay activeTask={activeTask} />
    </DndContext>
  );
}
