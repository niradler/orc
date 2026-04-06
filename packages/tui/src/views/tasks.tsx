import { TASK_STATUS_TRANSITIONS, type TaskStatus } from "@orc/core/types";
import { createOrcClient } from "@orc/sdk";
import type { Task } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { expectApiData } from "../api-result.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { DetailPane } from "../components/detail-pane.js";
import {
  EditFormOverlay,
  type FormField,
  formErrorMessage,
  isSaveKey,
  useEditForm,
} from "../components/edit-form.js";
import { ResourceTable } from "../components/resource-table.js";
import { ViewToolbar } from "../components/view-toolbar.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { useSort } from "../hooks/use-sort.js";
import {
  handleDetailEscapeKey,
  handleFilterInputKey,
  isFilterToggleKey,
  isOpenDetailKey,
  isRefreshKey,
} from "../navigation.js";
import { colors, priorityColor, statusColor, statusIcon } from "../theme.js";
import type { Column, KeyEvent, PaletteCommand, SelectOption, ViewKeyHandler, ViewState } from "../types.js";

const client = createOrcClient();

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
const STATUS_ORDER: Record<string, number> = {
  doing: 0,
  review: 1,
  blocked: 2,
  todo: 3,
  changes_requested: 4,
  done: 5,
  cancelled: 6,
};

const columns: Column<Task>[] = [
  {
    key: "status",
    label: "Status",
    width: 12,
    minWidth: 10,
    priority: 8,
    render: (t) => `${statusIcon(t.status)} ${t.status}`,
    color: (t) => statusColor[t.status] ?? colors.text,
    sortValue: (t) => STATUS_ORDER[t.status] ?? 99,
  },
  {
    key: "priority",
    label: "Priority",
    width: 10,
    minWidth: 8,
    priority: 7,
    render: (t) => t.priority,
    color: (t) => priorityColor[t.priority] ?? colors.text,
    sortValue: (t) => PRIORITY_ORDER[t.priority] ?? 99,
  },
  {
    key: "title",
    label: "Title",
    width: 60,
    minWidth: 20,
    priority: 9,
    render: (t) => t.title,
    sortValue: (t) => t.title.toLowerCase(),
  },
  {
    key: "author",
    label: "Author",
    width: 14,
    minWidth: 10,
    priority: 4,
    render: (t) => t.author,
    color: () => colors.textDim,
    sortValue: (t) => t.author.toLowerCase(),
  },
  {
    key: "tags",
    label: "Tags",
    width: 16,
    minWidth: 10,
    priority: 2,
    render: (t) => t.tags?.join(", ") ?? "—",
    color: () => colors.textDim,
  },
  {
    key: "claimed_by",
    label: "Claimed",
    width: 14,
    minWidth: 10,
    priority: 3,
    render: (t) => t.claimed_by ?? "—",
    color: () => colors.textDim,
  },
  {
    key: "updated_at",
    label: "Updated",
    width: 12,
    minWidth: 10,
    priority: 1,
    render: (t) => t.updated_at.slice(0, 10),
    color: () => colors.textDim,
    sortValue: (t) => t.updated_at,
  },
];

const TASK_PRIORITIES: SelectOption[] = [
  { label: "Low", value: "low" },
  { label: "Normal", value: "normal" },
  { label: "High", value: "high" },
  { label: "Critical", value: "critical" },
];

const STATUS_LABELS: Record<string, string> = {
  todo: "Todo",
  queued: "Queued",
  doing: "Doing",
  blocked: "Blocked",
  review: "Review",
  changes_requested: "Changes Requested",
  done: "Done",
  cancelled: "Cancelled",
  paused: "Paused",
};

function taskStatusOptions(currentStatus?: string): SelectOption[] {
  if (!currentStatus) {
    return ["todo", "doing", "blocked"].map((s) => ({ label: STATUS_LABELS[s] ?? s, value: s }));
  }
  const allowed = TASK_STATUS_TRANSITIONS[currentStatus as TaskStatus] ?? [];
  return [currentStatus, ...allowed].map((s) => ({ label: STATUS_LABELS[s] ?? s, value: s }));
}

function taskFields(t?: Task): FormField[] {
  return [
    {
      key: "title",
      label: "Title",
      value: t?.title ?? "",
      placeholder: "Add a concise task title",
    },
    {
      key: "body",
      label: "Body",
      value: t?.body ?? "",
      type: "textarea",
      height: 8,
      placeholder: "Describe the work, context, and acceptance criteria",
    },
    {
      key: "status",
      label: "Status",
      value: t?.status ?? "todo",
      type: "select",
      options: taskStatusOptions(t?.status),
    },
    {
      key: "priority",
      label: "Priority",
      value: t?.priority ?? "normal",
      type: "select",
      options: TASK_PRIORITIES,
    },
    {
      key: "tags",
      label: "Tags",
      value: t?.tags?.join(", ") ?? "",
      placeholder: "tag-one, tag-two",
      description: "Comma-separated tags help search and filtering.",
    },
  ];
}

type Props = {
  projectId: string | null;
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
  onStateChange: (state: ViewState) => void;
  onRegisterCommands: (cmds: PaletteCommand[]) => void;
  onRegisterSearch: (fns: { setQuery: (q: string) => void; clear: () => void }) => void;
};

export function TasksView({ projectId, onRegisterKeyHandler, onStateChange, onRegisterCommands, onRegisterSearch }: Props) {
  const [mode, setMode] = useState<"browse" | "detail" | "form" | "confirm">("browse");
  const [detail, setDetail] = useState<Task | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [formIntent, setFormIntent] = useState<"create" | "edit">("create");
  const [formTarget, setFormTarget] = useState<Task | null>(null);
  const editForm = useEditForm();
  const { sort, setSortByKey, sortData } = useSort(columns);

  const { data, loading, error, refresh, mutate } = usePolling(
    () => client.tasks.list({ ...(projectId ? { project_id: projectId } : {}), limit: 100 }),
    5000,
  );
  const tasks = data?.tasks ?? [];
  const {
    filtered: filteredUnsorted,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(
    tasks,
    (t) => `${t.title} ${t.status} ${t.priority} ${t.author} ${t.tags?.join(" ") ?? ""}`,
    true,
  );
  const filtered = sortData(filteredUnsorted);
  const {
    cursor,
    setCursor,
    handleKey: vimHandleKey,
  } = useVimList(filtered.length, mode === "browse" && !filterActive);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const filterActiveRef = useRef(filterActive);
  filterActiveRef.current = filterActive;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const setCursorRef = useRef(setCursor);
  setCursorRef.current = setCursor;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;
  const editFormRef = useRef(editForm);
  editFormRef.current = editForm;
  const deleteTargetRef = useRef(deleteTarget);
  deleteTargetRef.current = deleteTarget;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const formIntentRef = useRef(formIntent);
  formIntentRef.current = formIntent;
  const formTargetRef = useRef(formTarget);
  formTargetRef.current = formTarget;

  useEffect(() => {
    const selectedTask = filtered[cursor];
    const sortLabel = sort.key ? `${sort.key} ${sort.direction === "asc" ? "▲" : "▼"}` : null;
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Tasks",
      countLabel: loading ? "Loading tasks…" : `${filtered.length} tasks`,
      sortLabel,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode !== "browse",
      selectionLabel: selectedTask
        ? `${statusIcon(selectedTask.status)} ${selectedTask.status} • ${selectedTask.title}`
        : "No task selected yet.",
      detailId: mode === "detail" ? (detail?.id ?? null) : null,
      statusMessage: null,
      contextData:
        mode === "detail" && detail
          ? JSON.stringify(detail, null, 2)
          : filtered[cursor]
            ? JSON.stringify(filtered[cursor], null, 2)
            : null,
    });
  }, [mode, query, filterActive, onStateChange, filtered, cursor, detail, loading, sort]);

  useEffect(() => {
    const sortCommands: PaletteCommand[] = columns
      .filter((c) => c.sortValue)
      .map((col) => ({
        id: `sort-${col.key}`,
        name: `Sort by ${col.label}`,
        category: "sort" as const,
        aliases: [`sort ${col.key}`, `sort ${col.label.toLowerCase()}`],
        icon: "↕",
        ...(sort.key === col.key ? { hint: `${sort.direction === "asc" ? "▲" : "▼"} current` } : {}),
        available: () => modeRef.current === "browse",
        execute: () => setSortByKey(col.key),
      }));

    const filterCommands: PaletteCommand[] = [];
    const statuses = [...new Set(tasks.map((t) => t.status))];
    for (const s of statuses) {
      filterCommands.push({
        id: `filter-status-${s}`,
        name: `Filter status: ${s}`,
        category: "filter",
        aliases: [`filter status ${s}`, `filter status=${s}`, s],
        icon: "⏳",
        ...(query === s ? { hint: "active" } : {}),
        available: () => modeRef.current === "browse",
        execute: () => setQuery(s),
      });
    }
    const priorities = [...new Set(tasks.map((t) => t.priority))];
    for (const p of priorities) {
      filterCommands.push({
        id: `filter-priority-${p}`,
        name: `Filter priority: ${p}`,
        category: "filter",
        aliases: [`filter priority ${p}`, `filter priority=${p}`, p],
        icon: "🔺",
        ...(query === p ? { hint: "active" } : {}),
        available: () => modeRef.current === "browse",
        execute: () => setQuery(p),
      });
    }
    const authors = [...new Set(tasks.map((t) => t.author))];
    for (const a of authors) {
      filterCommands.push({
        id: `filter-author-${a}`,
        name: `Filter author: ${a}`,
        category: "filter",
        aliases: [`filter author ${a}`, `filter author=${a}`, a],
        icon: "👤",
        available: () => modeRef.current === "browse",
        execute: () => setQuery(a),
      });
    }
    filterCommands.push({
      id: "filter-clear",
      name: "Clear filter",
      category: "filter",
      aliases: ["filter clear", "filter reset", "clear filter"],
      icon: "✕",
      ...(query ? { hint: `filtering: "${query}"` } : {}),
      available: () => modeRef.current === "browse",
      execute: () => setQuery(""),
    });

    onRegisterCommands([...sortCommands, ...filterCommands]);
  }, [onRegisterCommands, setSortByKey, sort, tasks, query, setQuery]);

  useEffect(() => {
    onRegisterSearch({ setQuery, clear: () => setQuery("") });
  }, [onRegisterSearch, setQuery]);

  const doCreate = useCallback(
    async (vals: Record<string, string>) => {
      if (!vals.title) throw new Error("Title is required.");
      const tags = vals.tags
        ? vals.tags
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const created = await client.tasks.create({
        title: vals.title,
        ...(vals.body ? { body: vals.body } : {}),
        status: (vals.status as "todo" | "doing" | "blocked") || "todo",
        priority: (vals.priority as "low" | "normal" | "high" | "critical") || "normal",
        ...(tags ? { tags } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      });
      return expectApiData(created, "Couldn't create task.");
    },
    [projectId],
  );

  const doEdit = useCallback(async (vals: Record<string, string>) => {
    const task = formTargetRef.current ?? filteredRef.current[cursorRef.current];
    if (!task) throw new Error("Select a task first.");
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    const updated = await client.tasks.update(task.id, {
      ...(vals.title ? { title: vals.title } : {}),
      body: vals.body || null,
      ...(vals.status && vals.status !== task.status
        ? { status: vals.status as Task["status"] }
        : {}),
      ...(vals.priority ? { priority: vals.priority as Task["priority"] } : {}),
      tags,
    });
    return expectApiData(updated, "Couldn't save task.");
  }, []);

  const doCreateRef = useRef(doCreate);
  doCreateRef.current = doCreate;
  const doEditRef = useRef(doEdit);
  doEditRef.current = doEdit;

  const submitCurrentForm = useCallback(async () => {
    const result = editFormRef.current.submit();
    const creating = formIntentRef.current === "create";
    const action = creating ? doCreateRef.current : doEditRef.current;

    if (!editFormRef.current.beginSubmit(creating ? "Creating task…" : "Saving task…")) return;

    try {
      const savedTask = await action(result.values);
      if (savedTask) setDetail(savedTask);
      editFormRef.current.finishSubmit("success", creating ? "Task created." : "Task saved.");
      setTimeout(() => {
        editFormRef.current.close();
        setFormTarget(null);
        if (savedTask) {
          mutateRef.current((current) => {
            if (!current) return { tasks: [savedTask], total: 1 };
            if (creating) {
              return { tasks: [savedTask, ...current.tasks], total: current.total + 1 };
            }
            return {
              ...current,
              tasks: current.tasks.map((t) => (t.id === savedTask.id ? savedTask : t)),
            };
          });
        }
        setMode("browse");
      }, 700);
    } catch (error) {
      editFormRef.current.finishSubmit("error", formErrorMessage(error, "Couldn't save task."));
    }
  }, []);

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (filterActiveRef.current) {
        return handleFilterInputKey(key.name, setFilterActive);
      }

      if (modeRef.current === "form") {
        if (key.name === "escape") {
          if (editFormRef.current.submitState.status === "saving") return true;
          editFormRef.current.close();
          setMode("browse");
          setFormTarget(null);
          return true;
        }
        if (isSaveKey(key)) {
          void submitCurrentForm();
          return true;
        }
        if (key.name === "tab" && key.shift) {
          editFormRef.current.prevField();
          return true;
        }
        if (key.name === "tab") {
          editFormRef.current.nextField();
          return true;
        }
        return true;
      }

      if (modeRef.current === "confirm") {
        if (key.name === "y" || key.name === "return") {
          const t = deleteTargetRef.current;
          if (t) client.tasks.delete(t.id).then(() => refreshRef.current());
          setDeleteTarget(null);
          setMode("browse");
          return true;
        }
        if (key.name === "n" || key.name === "escape") {
          setDeleteTarget(null);
          setMode("browse");
          return true;
        }
        return true;
      }

      if (modeRef.current === "browse" && !filterActiveRef.current) {
        if (vimHandleKey(key)) return true;
        if (isFilterToggleKey(key.name)) {
          setFilterActive(true);
          return true;
        }
        if (isOpenDetailKey(key.name)) {
          const task = filteredRef.current[cursorRef.current];
          if (task)
            client.tasks.get(task.id).then((r) => {
              if (r.data) {
                setDetail(r.data);
                setMode("detail");
              }
            });
          return true;
        }
        if (isRefreshKey(key.name)) {
          refreshRef.current();
          return true;
        }
        if (key.name === "n") {
          setFormIntent("create");
          setFormTarget(null);
          editFormRef.current.open(taskFields());
          setMode("form");
          return true;
        }
        if (key.name === "e") {
          const task = filteredRef.current[cursorRef.current];
          if (task) {
            client.tasks.get(task.id).then((r) => {
              if (r.data) {
                setFormIntent("edit");
                setFormTarget(r.data);
                editFormRef.current.open(taskFields(r.data));
                setMode("form");
              }
            });
          }
          return true;
        }
        if (key.name === "d") {
          const task = filteredRef.current[cursorRef.current];
          if (task) {
            setDeleteTarget(task);
            setMode("confirm");
          }
          return true;
        }
      }
      if (modeRef.current === "detail") {
        if (
          handleDetailEscapeKey(key.name, () => {
            setMode("browse");
            setDetail(null);
          })
        )
          return true;
        if (key.name === "e" && detailRef.current) {
          setFormIntent("edit");
          setFormTarget(detailRef.current);
          editFormRef.current.open(taskFields(detailRef.current));
          setMode("form");
          return true;
        }
        if (key.name === "d" && detailRef.current) {
          setDeleteTarget(detailRef.current);
          setMode("confirm");
          return true;
        }
        return false;
      }
      return false;
    },
    [submitCurrentForm, vimHandleKey, setFilterActive],
  );

  useEffect(() => {
    onRegisterKeyHandler(handleKey);
  }, [handleKey, onRegisterKeyHandler]);

  if (mode === "detail" && detail) {
    const fields = [
      { label: "ID", value: detail.id, color: colors.textDim },
      {
        label: "Status",
        value: `${statusIcon(detail.status)} ${detail.status}`,
        color: statusColor[detail.status] ?? colors.text,
      },
      {
        label: "Priority",
        value: detail.priority,
        color: priorityColor[detail.priority] ?? colors.text,
      },
      { label: "Progress", value: `${detail.progress}%` },
      { label: "Author", value: detail.author },
      { label: "Claimed By", value: detail.claimed_by ?? "—" },
      { label: "Tags", value: detail.tags?.join(", ") ?? "—" },
      { label: "Due", value: detail.due_at ?? "—" },
      { label: "Created", value: detail.created_at },
      { label: "Updated", value: detail.updated_at },
    ];
    return (
      <DetailPane
        title={`Task: ${detail.title}`}
        fields={fields}
        body={detail.body ?? undefined}
        renderMarkdown
        hint="Esc back • e edit • d delete • Up/Down scroll"
      />
    );
  }

  const selectedTask = filtered[cursor];

  return (
    <box flexDirection="column" flexGrow={1}>
      <ViewToolbar
        title="Tasks"
        countLabel={loading ? "Loading tasks…" : `${filtered.length} visible tasks`}
        filterQuery={query}
        filterActive={filterActive}
        filterPlaceholder="Search tasks, status, priority, author, tags"
        onFilterChange={setQuery}
        onFilterSubmit={() => setFilterActive(false)}
        statusMessage={projectId ? "Project-scoped view" : "All projects"}
      />
      <ResourceTable
        columns={columns}
        data={filtered}
        cursor={cursor}
        keyFn={(t) => t.id}
        loading={loading}
        error={error}
        emptyMessage="No tasks to show yet."
        filteredEmptyMessage="No tasks match the current search."
        hasActiveFilter={Boolean(query)}
        sort={sort}
        selectedSummary={
          selectedTask
            ? `${statusIcon(selectedTask.status)} ${selectedTask.status} • ${selectedTask.priority} • ${selectedTask.title}`
            : "Create a task with n, or switch projects from the Projects tab."
        }
      />
      {mode === "form" && (
        <EditFormOverlay
          title={formIntent === "create" ? "New Task" : "Edit Task"}
          fields={editForm.fields}
          focusIdx={editForm.focusIdx}
          onChange={editForm.updateValue}
          submitState={editForm.submitState}
          onSubmit={submitCurrentForm}
          onCancel={() => {
            if (editForm.submitState.status === "saving") return;
            editForm.close();
            setMode("browse");
            setFormTarget(null);
          }}
          onNextField={editForm.nextField}
          onPrevField={editForm.prevField}
        />
      )}
      {mode === "confirm" && deleteTarget && (
        <ConfirmDialog message={`Delete task "${deleteTarget.title}"?`} />
      )}
    </box>
  );
}
