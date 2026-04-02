import { createOrcClient } from "@orc/sdk";
import type { Task } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { DetailPane } from "../components/detail-pane.js";
import { EditFormOverlay, type FormField, useEditForm } from "../components/edit-form.js";
import { ResourceTable } from "../components/resource-table.js";
import { ViewToolbar } from "../components/view-toolbar.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors, priorityColor, statusColor, statusIcon } from "../theme.js";
import type { Column, KeyEvent, SelectOption, ViewKeyHandler, ViewState } from "../types.js";

const client = createOrcClient();

const columns: Column<Task>[] = [
  {
    key: "status",
    label: "Status",
    width: 12,
    render: (t) => `${statusIcon(t.status)} ${t.status}`,
    color: (t) => statusColor[t.status] ?? colors.text,
  },
  {
    key: "priority",
    label: "Pri",
    width: 10,
    render: (t) => t.priority,
    color: (t) => priorityColor[t.priority] ?? colors.text,
  },
  { key: "title", label: "Title", width: 60, render: (t) => t.title },
  {
    key: "author",
    label: "Author",
    width: 14,
    render: (t) => t.author,
    color: () => colors.textDim,
  },
];

const TASK_PRIORITIES: SelectOption[] = [
  { label: "Low", value: "low" },
  { label: "Normal", value: "normal" },
  { label: "High", value: "high" },
  { label: "Critical", value: "critical" },
];

function taskStatusOptions(includeExtended: boolean): SelectOption[] {
  const base: SelectOption[] = [
    { label: "Todo", value: "todo" },
    { label: "Doing", value: "doing" },
    { label: "Blocked", value: "blocked" },
  ];
  if (!includeExtended) return base;
  return [
    ...base,
    { label: "Review", value: "review" },
    { label: "Done", value: "done" },
    { label: "Cancelled", value: "cancelled" },
  ];
}

function taskFields(t?: Task): FormField[] {
  const includeExtendedStatuses = Boolean(t);
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
      options: taskStatusOptions(includeExtendedStatuses),
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
};

export function TasksView({ projectId, onRegisterKeyHandler, onStateChange }: Props) {
  const [mode, setMode] = useState<"browse" | "detail" | "form" | "confirm">("browse");
  const [detail, setDetail] = useState<Task | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [formIntent, setFormIntent] = useState<"create" | "edit">("create");
  const [formTarget, setFormTarget] = useState<Task | null>(null);
  const editForm = useEditForm();

  const { data, loading, error, refresh } = usePolling(
    () => client.tasks.list({ ...(projectId ? { project_id: projectId } : {}), limit: 100 }),
    5000,
  );
  const tasks = data?.tasks ?? [];
  const {
    filtered,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(
    tasks,
    (t) => `${t.title} ${t.status} ${t.priority} ${t.author} ${t.tags?.join(" ") ?? ""}`,
    true,
  );
  const { cursor, handleKey: vimHandleKey } = useVimList(
    filtered.length,
    mode === "browse" && !filterActive,
  );

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const filterActiveRef = useRef(filterActive);
  filterActiveRef.current = filterActive;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
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
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Tasks",
      countLabel: loading ? "Loading tasks…" : `${filtered.length} visible tasks`,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode === "form" || mode === "confirm",
      selectionLabel:
        mode === "detail" && detail
          ? `Task detail • ${detail.title}`
          : selectedTask
            ? `${statusIcon(selectedTask.status)} ${selectedTask.status} • ${selectedTask.title}`
            : "No task selected yet.",
      detailId: mode === "detail" ? (detail?.id ?? null) : null,
      statusMessage: filterActive ? "Search updates live as you type." : null,
    });
  }, [mode, query, filterActive, onStateChange, filtered, cursor, detail, loading]);

  const doCreate = useCallback(
    (vals: Record<string, string>) => {
      if (!vals.title) return;
      const tags = vals.tags
        ? vals.tags
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      client.tasks
        .create({
          title: vals.title,
          ...(vals.body ? { body: vals.body } : {}),
          status: (vals.status as "todo" | "doing" | "blocked") || "todo",
          priority: (vals.priority as "low" | "normal" | "high" | "critical") || "normal",
          ...(tags ? { tags } : {}),
          ...(projectId ? { project_id: projectId } : {}),
        })
        .then(() => refreshRef.current());
    },
    [projectId],
  );

  const doEdit = useCallback((vals: Record<string, string>) => {
    const task = formTargetRef.current ?? filteredRef.current[cursorRef.current];
    if (!task) return;
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    client.tasks
      .update(task.id, {
        ...(vals.title ? { title: vals.title } : {}),
        body: vals.body || null,
        ...(vals.status ? { status: vals.status as Task["status"] } : {}),
        ...(vals.priority ? { priority: vals.priority as Task["priority"] } : {}),
        tags,
      })
      .then(() => refreshRef.current());
  }, []);

  const doCreateRef = useRef(doCreate);
  doCreateRef.current = doCreate;
  const doEditRef = useRef(doEdit);
  doEditRef.current = doEdit;

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (filterActiveRef.current) {
        if (key.name === "escape") {
          setFilterActive(false);
          return true;
        }
        if (key.name === "return") {
          setFilterActive(false);
          return true;
        }
        return true;
      }

      if (modeRef.current === "form") {
        if (key.name === "escape") {
          editFormRef.current.close();
          setMode("browse");
          setFormTarget(null);
          return true;
        }
        if (key.ctrl && key.name === "s") {
          const result = editFormRef.current.submit();
          const fn = formIntentRef.current === "create" ? doCreateRef.current : doEditRef.current;
          fn(result.values);
          setMode("browse");
          setFormTarget(null);
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
        if (key.name === "/" || key.name === "f") {
          setFilterActive(true);
          return true;
        }
        if (key.name === "return") {
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
        if (key.name === "r") {
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
          const t = filteredRef.current[cursorRef.current];
          if (t) {
            setFormIntent("edit");
            setFormTarget(t);
            editFormRef.current.open(taskFields(t));
            setMode("form");
          }
          return true;
        }
        if (key.name === "d") {
          const t = filteredRef.current[cursorRef.current];
          if (t) {
            setDeleteTarget(t);
            setMode("confirm");
          }
          return true;
        }
      }
      if (modeRef.current === "detail") {
        if (key.name === "escape") {
          setMode("browse");
          setDetail(null);
          return true;
        }
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
    [vimHandleKey, setFilterActive],
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
        selectedSummary={
          selectedTask
            ? `${statusIcon(selectedTask.status)} ${selectedTask.status} • ${selectedTask.priority} • ${selectedTask.title}`
            : "Create a task with n, or switch projects from the Projects tab."
        }
      />
      <EditFormOverlay
        title={formIntent === "create" ? "New Task" : "Edit Task"}
        fields={editForm.fields}
        focusIdx={editForm.focusIdx}
        active={mode === "form"}
        onChange={editForm.updateValue}
      />
      <ConfirmDialog
        message={deleteTarget ? `Delete task "${deleteTarget.title}"?` : ""}
        active={mode === "confirm"}
      />
    </box>
  );
}
