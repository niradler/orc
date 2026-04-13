import { DragOverlay } from "@dnd-kit/core";
import type { Task } from "@/api/client";
import { KanbanCard } from "./KanbanCard";

interface KanbanCardOverlayProps {
  activeTask: Task | null;
}

export function KanbanCardOverlay({ activeTask }: KanbanCardOverlayProps) {
  return (
    <DragOverlay dropAnimation={null}>
      {activeTask ? (
        <div className="w-[260px]">
          <KanbanCard task={activeTask} onDelete={() => {}} isDragOverlay />
        </div>
      ) : null}
    </DragOverlay>
  );
}
