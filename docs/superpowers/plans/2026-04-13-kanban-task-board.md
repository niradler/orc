# Kanban Task Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the table-based task view with a Kanban board (like Jira/Trello/Monday) featuring drag-and-drop columns organized by status, with validated transitions and a toggle to switch between board/table views.

**Architecture:** Use `@dnd-kit/core` + `@dnd-kit/sortable` for drag-and-drop primitives. Build a column-per-status board where cards can be dragged between columns. Enforce the existing `TASK_STATUS_TRANSITIONS` rules on drop — invalid moves snap back with visual feedback. The existing table view is preserved behind a view-mode toggle. New components are composed from existing shadcn/ui primitives and the project's Tailwind dark theme.

**Tech Stack:** React 19, @dnd-kit/core + @dnd-kit/sortable, Tailwind CSS, shadcn/ui, React Query (existing), lucide-react (existing)

---

## Design Direction

**Aesthetic:** Industrial mission-control — extends the existing dark navy palette (`#090e1a` bg, `#131928`–`#242c3f` surfaces). Columns have subtle status-tinted top borders (blue for doing, orange for review, red for blocked, green for done). Cards are compact dark tiles with priority-colored left accents. Drag feedback uses a translucent ghost with a glow matching the destination column color. Invalid drop zones dim with a dashed outline.

**Column Layout:**
- 6 primary columns always visible: **Todo**, **Doing**, **Review**, **Blocked**, **Done**, **Backlog** (collapsed group: Queued + Paused + Cancelled + Changes Requested)
- Backlog is a collapsible column on the left that groups less-active statuses
- Each column header shows count badge and status color indicator
- Columns scroll vertically independently

**Card Design:**
- Priority stripe on left edge (4px, color-coded)
- Title (truncated at 2 lines)
- Bottom row: author avatar initial, tags (max 2), relative time
- Hover: subtle lift + border glow
- Critical priority cards have a pulsing left stripe

**Status Transition Validation on Drag:**
```
todo                 → doing, queued, paused, cancelled
queued               → doing, todo, cancelled
doing                → review, blocked, paused, cancelled
blocked              → doing, todo, cancelled
review               → done, changes_requested
changes_requested    → doing, queued, paused
done                 → [] (terminal — no drag out)
paused               → todo
cancelled            → [] (terminal — no drag out)
```

---

## File Structure

```
packages/web/src/
├── views/
│   └── Tasks.tsx                    # MODIFY — add view toggle, import board
├── components/
│   ├── board/
│   │   ├── KanbanBoard.tsx          # CREATE — main board layout + DndContext
│   │   ├── KanbanColumn.tsx         # CREATE — single status column + SortableContext
│   │   ├── KanbanCard.tsx           # CREATE — draggable task card
│   │   ├── KanbanCardOverlay.tsx    # CREATE — drag overlay (ghost card)
│   │   └── board-utils.ts           # CREATE — transition validation, column config
│   └── StatusBadge.tsx              # NO CHANGE — reused as-is on cards
├── hooks/
│   └── useTasks.ts                  # NO CHANGE — existing hooks work as-is
```

---

## Task 1: Install @dnd-kit dependencies

**Files:**
- Modify: `packages/web/package.json`

- [ ] **Step 1: Install dnd-kit packages**

Run from repo root:
```bash
cd packages/web && bun add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

- [ ] **Step 2: Verify install**

```bash
cd packages/web && bun run typecheck
```
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/package.json packages/web/bun.lockb
git commit -m "feat(web): add @dnd-kit/core and @dnd-kit/sortable for kanban board"
```

---

## Task 2: Create board utility functions

**Files:**
- Create: `packages/web/src/components/board/board-utils.ts`

- [ ] **Step 1: Create board-utils.ts with column config and transition validation**

```ts
import type { TaskStatus } from "@/api/client";

/** Columns shown on the Kanban board in display order. */
export const BOARD_COLUMNS: { status: TaskStatus; label: string; color: string }[] = [
  { status: "todo", label: "Todo", color: "#a6abbb" },
  { status: "queued", label: "Queued", color: "#549fff" },
  { status: "doing", label: "In Progress", color: "#78b0ff" },
  { status: "review", label: "Review", color: "#ffa851" },
  { status: "changes_requested", label: "Changes", color: "#eb8800" },
  { status: "blocked", label: "Blocked", color: "#ff716c" },
  { status: "done", label: "Done", color: "#70fda7" },
  { status: "paused", label: "Paused", color: "#707584" },
  { status: "cancelled", label: "Cancelled", color: "#434856" },
];

/** Valid status transitions — mirrors @orc/core TASK_STATUS_TRANSITIONS. */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["doing", "queued", "paused", "cancelled"],
  queued: ["doing", "todo", "cancelled"],
  doing: ["review", "blocked", "paused", "cancelled"],
  blocked: ["doing", "todo", "cancelled"],
  review: ["done", "changes_requested"],
  changes_requested: ["doing", "queued", "paused"],
  done: [],
  paused: ["todo"],
  cancelled: [],
};

/** Check if a task can transition from its current status to the target column. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Get all valid target statuses for a given source status. */
export function validTargets(from: TaskStatus): TaskStatus[] {
  return TRANSITIONS[from] ?? [];
}

/** Priority to left-accent color mapping. */
export const PRIORITY_COLORS: Record<string, string> = {
  critical: "#ff716c",
  high: "#ffa851",
  normal: "#78b0ff",
  low: "#707584",
};
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/web && bun run typecheck
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/board/board-utils.ts
git commit -m "feat(web): add kanban board utility functions and column config"
```

---

## Task 3: Create KanbanCard component

**Files:**
- Create: `packages/web/src/components/board/KanbanCard.tsx`

- [ ] **Step 1: Create the draggable task card component**

```tsx
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "@/api/client";
import { PRIORITY_COLORS } from "./board-utils";
import { Trash2 } from "lucide-react";

interface KanbanCardProps {
  task: Task;
  onDelete: (id: string) => void;
  isDragOverlay?: boolean;
}

export function KanbanCard({ task, onDelete, isDragOverlay }: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { type: "task", task } });

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
        {/* Title */}
        <p className="font-body text-xs text-on-surface line-clamp-2 leading-relaxed">
          {task.title}
        </p>

        {/* Bottom row: meta */}
        <div className="flex items-center justify-between mt-2 gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {/* Author initial */}
            <span
              className="flex-shrink-0 w-4 h-4 rounded-sm bg-surface-highest
                text-[8px] font-label font-bold text-outline
                flex items-center justify-center uppercase"
            >
              {task.author[0]}
            </span>

            {/* Tags (max 2) */}
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
            {/* Relative time */}
            <span className="text-[9px] font-label text-outline">
              {formatRelative(task.updated_at)}
            </span>

            {/* Delete */}
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
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/web && bun run typecheck
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/board/KanbanCard.tsx
git commit -m "feat(web): add KanbanCard component with priority accent and drag support"
```

---

## Task 4: Create KanbanCardOverlay component

**Files:**
- Create: `packages/web/src/components/board/KanbanCardOverlay.tsx`

- [ ] **Step 1: Create the drag overlay (ghost card shown while dragging)**

```tsx
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
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/web && bun run typecheck
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/board/KanbanCardOverlay.tsx
git commit -m "feat(web): add KanbanCardOverlay drag ghost component"
```

---

## Task 5: Create KanbanColumn component

**Files:**
- Create: `packages/web/src/components/board/KanbanColumn.tsx`

- [ ] **Step 1: Create the status column with droppable zone**

```tsx
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
  isValidDrop: boolean | null; // null = no drag active, true = valid target, false = invalid
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
      {/* Column header */}
      <div className="flex-shrink-0 px-3 py-2.5 border-b border-surface-highest">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* Status color dot */}
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

        {/* Top accent bar */}
        <div
          className="h-0.5 mt-2 rounded-full opacity-40"
          style={{ backgroundColor: color }}
        />
      </div>

      {/* Scrollable card area */}
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
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/web && bun run typecheck
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/board/KanbanColumn.tsx
git commit -m "feat(web): add KanbanColumn with droppable zone and visual feedback"
```

---

## Task 6: Create KanbanBoard component (main board with DndContext)

**Files:**
- Create: `packages/web/src/components/board/KanbanBoard.tsx`

- [ ] **Step 1: Create the main board component**

```tsx
import { useState, useMemo } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import type { Task, TaskStatus } from "@/api/client";
import { KanbanColumn } from "./KanbanColumn";
import { KanbanCardOverlay } from "./KanbanCardOverlay";
import { BOARD_COLUMNS, canTransition, validTargets } from "./board-utils";

interface KanbanBoardProps {
  tasks: Task[];
  onUpdateStatus: (id: string, status: TaskStatus) => void;
  onDeleteTask: (id: string) => void;
}

export function KanbanBoard({ tasks, onUpdateStatus, onDeleteTask }: KanbanBoardProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Group tasks by status
  const tasksByStatus = useMemo(() => {
    const map: Record<TaskStatus, Task[]> = {
      todo: [], queued: [], doing: [], review: [],
      changes_requested: [], blocked: [], done: [],
      paused: [], cancelled: [],
    };
    for (const task of tasks) {
      map[task.status]?.push(task);
    }
    return map;
  }, [tasks]);

  // Compute which columns are valid drop targets for the active card
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

    // Determine the target column status
    let targetStatus: TaskStatus | undefined;

    if (over.data.current?.type === "column") {
      targetStatus = over.data.current.status as TaskStatus;
    } else if (over.data.current?.type === "task") {
      // Dropped on a card — find which column that card belongs to
      const overTask = over.data.current.task as Task;
      targetStatus = overTask.status;
    }

    if (!targetStatus) return;
    if (targetStatus === task.status) return; // same column, no-op
    if (!canTransition(task.status, targetStatus)) return; // invalid transition

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
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/web && bun run typecheck
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/board/KanbanBoard.tsx
git commit -m "feat(web): add KanbanBoard with DndContext and transition validation"
```

---

## Task 7: Integrate board into Tasks view with view toggle

**Files:**
- Modify: `packages/web/src/views/Tasks.tsx`

- [ ] **Step 1: Add view toggle and board import to Tasks.tsx**

Replace the entire `Tasks.tsx` with the updated version that adds a board/table toggle. The key changes:

1. Add `viewMode` state (`"board" | "table"`)
2. Add toggle buttons in the header
3. Conditionally render `KanbanBoard` or the existing table
4. Keep the existing `CreateTaskDialog` unchanged

```tsx
import { useState } from "react";
import { useTasks, useCreateTask, useUpdateTask, useDeleteTask } from "@/hooks/useTasks";
import { ViewHeader } from "@/components/ViewHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { PriorityBadge } from "@/components/PriorityBadge";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { KanbanBoard } from "@/components/board/KanbanBoard";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, LayoutGrid, List } from "lucide-react";
import type { TaskPriority, TaskStatus } from "@/api/client";

type ViewMode = "board" | "table";

const STATUS_TABS: Array<{ value: TaskStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "todo", label: "Todo" },
  { value: "doing", label: "Doing" },
  { value: "review", label: "Review" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

const ALL_STATUSES: TaskStatus[] = [
  "todo", "queued", "doing", "review", "changes_requested", "blocked", "done", "cancelled", "paused",
];

const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "critical"];

export default function Tasks() {
  const [viewMode, setViewMode] = useState<ViewMode>("board");
  const [filter, setFilter] = useState<TaskStatus | "all">("all");
  const [creating, setCreating] = useState(false);

  const { data: allTasks, isLoading, error, refetch } = useTasks();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const visible =
    filter === "all" ? (allTasks ?? []) : (allTasks ?? []).filter((t) => t.status === filter);

  const counts = (allTasks ?? []).reduce(
    (acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; },
    {} as Record<string, number>,
  );

  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Tasks"
        meta={`${(allTasks ?? []).length} total`}
        action={
          <div className="flex items-center gap-2">
            {/* View toggle */}
            <div className="flex border border-surface-highest rounded-sm overflow-hidden">
              <button
                onClick={() => setViewMode("board")}
                className={`p-1.5 transition-colors ${
                  viewMode === "board"
                    ? "bg-primary/15 text-primary"
                    : "text-outline hover:text-on-surface-variant"
                }`}
              >
                <LayoutGrid size={14} />
              </button>
              <button
                onClick={() => setViewMode("table")}
                className={`p-1.5 transition-colors ${
                  viewMode === "table"
                    ? "bg-primary/15 text-primary"
                    : "text-outline hover:text-on-surface-variant"
                }`}
              >
                <List size={14} />
              </button>
            </div>

            <Button size="sm" onClick={() => setCreating(true)}
              className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20">
              + New Task
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-surface-highest" />)}
        </div>
      ) : viewMode === "board" ? (
        <KanbanBoard
          tasks={allTasks ?? []}
          onUpdateStatus={(id, status) => updateTask.mutate({ id, status })}
          onDeleteTask={(id) => deleteTask.mutate(id)}
        />
      ) : (
        <>
          {/* Table view with status tabs (existing behavior) */}
          <Tabs value={filter} onValueChange={(v) => setFilter(v as TaskStatus | "all")} className="mb-4">
            <TabsList className="bg-surface-highest border border-surface-highest gap-0 h-auto p-0">
              {STATUS_TABS.map(({ value, label }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="font-label text-[10px] uppercase tracking-widest px-4 py-2 rounded-none
                    data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none
                    text-outline hover:text-on-surface-variant"
                >
                  {label}
                  {value !== "all" && counts[value] != null && (
                    <span className="ml-1.5 text-[9px] bg-surface-highest px-1.5 py-0.5 rounded-sm">
                      {counts[value]}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {visible.length === 0 ? (
            <EmptyState message="No tasks" />
          ) : (
            <div className="border border-surface-highest rounded-sm overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-surface-highest hover:bg-transparent">
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-16">ID</TableHead>
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Title</TableHead>
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-40">Status</TableHead>
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">Priority</TableHead>
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Author</TableHead>
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Updated</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((task) => (
                    <TableRow key={task.id} className="border-b border-surface-highest/50 hover:bg-surface-low">
                      <TableCell className="font-label text-[10px] text-outline">{task.id.slice(-6)}</TableCell>
                      <TableCell className="font-body text-xs text-on-surface max-w-xs truncate">{task.title}</TableCell>
                      <TableCell>
                        <Select
                          value={task.status}
                          onValueChange={(v) => updateTask.mutate({ id: task.id, status: v as TaskStatus })}
                        >
                          <SelectTrigger className="h-6 w-auto border-0 bg-transparent p-0 focus:ring-0 gap-1">
                            <SelectValue>
                              <StatusBadge status={task.status} />
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent className="bg-surface-highest border-surface-highest">
                            {ALL_STATUSES.map((s) => (
                              <SelectItem key={s} value={s} className="font-label text-xs uppercase">
                                {s.replace(/_/g, " ")}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell><PriorityBadge priority={task.priority} /></TableCell>
                      <TableCell className="font-label text-[10px] text-outline">{task.author}</TableCell>
                      <TableCell className="font-label text-[10px] text-outline">
                        {new Date(task.updated_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <button
                          onClick={() => deleteTask.mutate(task.id)}
                          className="text-outline hover:text-error transition-colors p-1"
                        >
                          <Trash2 size={12} />
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}

      {creating && <CreateTaskDialog open={creating} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [status, setStatus] = useState<TaskStatus>("todo");

  const createTask = useCreateTask();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    createTask.mutate(
      { title: title.trim(), body: body.trim() || undefined, priority, status },
      { onSuccess: () => { setTitle(""); setBody(""); onClose(); } },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-md">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            New Task
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Title *</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Body</Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Optional description..."
              className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-label text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-highest border-surface-highest">
                  {ALL_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="font-label text-xs">{s.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
                <SelectTrigger className="bg-background border-surface-highest text-on-surface font-label text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-surface-highest border-surface-highest">
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p} className="font-label text-xs">{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}
              className="font-label text-xs uppercase text-outline">Cancel</Button>
            <Button type="submit" size="sm" disabled={createTask.isPending || !title.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25">
              {createTask.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify typecheck**

```bash
cd packages/web && bun run typecheck
```
Expected: PASS

- [ ] **Step 3: Verify build**

```bash
cd packages/web && bun run build
```
Expected: PASS — no build errors

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/views/Tasks.tsx
git commit -m "feat(web): integrate kanban board into tasks view with board/table toggle"
```

---

## Task 8: Add subtle animation CSS for critical priority pulse

**Files:**
- Modify: `packages/web/src/index.css`

- [ ] **Step 1: Add the pulse-subtle keyframe animation**

Add after the existing `terminal-glow` utility:

```css
@layer utilities {
  .terminal-glow {
    text-shadow: 0 0 8px rgba(120, 176, 255, 0.4);
  }

  .animate-pulse-subtle {
    animation: pulse-subtle 3s ease-in-out infinite;
  }
}

@keyframes pulse-subtle {
  0%, 100% { border-left-color: rgba(255, 113, 108, 0.4); }
  50% { border-left-color: rgba(255, 113, 108, 1); }
}
```

- [ ] **Step 2: Verify dev server shows the board**

```bash
cd packages/web && bun run dev
```

Open `http://localhost:3000` in the browser. The Tasks view should now default to the Kanban board. Verify:
- Columns render for all 9 statuses
- Cards show in the correct columns
- Drag a card between valid columns — status updates
- Drag a card to an invalid column — snaps back, column dims
- Toggle to table view — original table renders
- Toggle back to board — board re-renders
- Create a new task via "+ New Task" — it appears in the correct column
- Delete a card — it disappears

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/index.css
git commit -m "feat(web): add subtle pulse animation for critical priority kanban cards"
```

---

## Task 9: Visual polish and final integration test

**Files:**
- Possibly modify: any of the board components for polish adjustments

- [ ] **Step 1: Manual QA checklist in browser**

Open `http://localhost:3000` and verify each item:

1. **Board renders all columns** — 9 columns, horizontally scrollable
2. **Cards grouped correctly** — each card appears in its status column
3. **Drag valid transition** — drag a `todo` card to `doing` → card moves, API updates
4. **Drag invalid transition** — drag a `done` card to `doing` → snaps back, no API call
5. **Visual feedback while dragging** — valid columns highlight (blue border), invalid columns dim (dashed, faded)
6. **Ghost card** — translucent overlay follows cursor during drag
7. **Priority accent** — left border stripe matches priority color
8. **Critical pulse** — critical priority cards have subtle pulsing left border
9. **Card metadata** — author initial, tags (max 2), relative time visible
10. **Delete button** — appears on hover, deletes card
11. **Create task** — dialog works, new task appears in correct column
12. **View toggle** — board/table toggle in header switches views cleanly
13. **Table view** — status tabs and table render identically to before
14. **Empty columns** — show "Empty" placeholder text
15. **Responsive scroll** — horizontal scroll on narrow viewports

- [ ] **Step 2: Fix any visual issues found during QA**

Adjust spacing, colors, or layout as needed.

- [ ] **Step 3: Final commit if changes were made**

```bash
git add -u packages/web/src/
git commit -m "fix(web): kanban board visual polish from QA"
```

---

## Summary

| Task | Component | Status |
|------|-----------|--------|
| 1 | Install @dnd-kit | ⬜ |
| 2 | board-utils.ts | ⬜ |
| 3 | KanbanCard | ⬜ |
| 4 | KanbanCardOverlay | ⬜ |
| 5 | KanbanColumn | ⬜ |
| 6 | KanbanBoard | ⬜ |
| 7 | Tasks.tsx integration | ⬜ |
| 8 | CSS animations | ⬜ |
| 9 | Visual QA | ⬜ |
