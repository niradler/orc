import { appendFileSync } from "node:fs";
import { createOrcClient } from "@orc/sdk";
import type { Task } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { DetailPane } from "../components/detail-pane.js";
import {
  EditFormOverlay,
  type FormField,
  type FormResult,
  useEditForm,
} from "../components/edit-form.js";
import { ResourceTable } from "../components/resource-table.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors, priorityColor, statusColor, statusIcon } from "../theme.js";
import type { Column, KeyEvent, ViewKeyHandler, ViewMode } from "../types.js";

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

function taskFields(t?: Task): FormField[] {
  return [
    { key: "title", label: "Title", value: t?.title ?? "" },
    { key: "body", label: "Body", value: t?.body ?? "" },
    {
      key: "status",
      label: "Status",
      value: t?.status ?? "todo",
      options: ["todo", "doing", "review", "blocked", "done", "cancelled"],
    },
    {
      key: "priority",
      label: "Priority",
      value: t?.priority ?? "normal",
      options: ["low", "normal", "high", "critical"],
    },
    { key: "tags", label: "Tags", value: t?.tags?.join(", ") ?? "" },
  ];
}

type Props = {
  projectId: string | null;
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
  onStateChange: (mode: ViewMode, filterQuery: string, filterActive: boolean) => void;
};

export function TasksView({ projectId, onRegisterKeyHandler, onStateChange }: Props) {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<Task | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const editForm = useEditForm();

  const { data, loading, refresh } = usePolling(
    () => client.tasks.list({ ...(projectId ? { project_id: projectId } : {}), limit: 100 }),
    5000,
  );
  const tasks = data?.tasks ?? [];
  const {
    filtered,
    query,
    active: filterActive,
    handleKey: filterHandleKey,
  } = useFilter(tasks, (t) => `${t.title} ${t.status} ${t.priority} ${t.author}`, mode === "list");
  const { cursor, handleKey: vimHandleKey } = useVimList(
    filtered.length,
    mode === "list" && !filterActive,
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

  useEffect(() => {
    onStateChange(mode, query, filterActive);
  }, [mode, query, filterActive, onStateChange]);

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
    const task = filteredRef.current[cursorRef.current];
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
      appendFileSync("tui-debug.log", `TASK: key=${key.name} mode=${modeRef.current} formActive=${editFormRef.current.active}\n`);
      if (modeRef.current === "edit" || modeRef.current === "create") {
        const result: FormResult | null = editFormRef.current.handleKey(key);
        appendFileSync("tui-debug.log", `FORM: key=${key.name} result=${JSON.stringify(result)} mode=${modeRef.current}\n`);
        if (result?.submitted) {
          const fn = modeRef.current === "create" ? doCreateRef.current : doEditRef.current;
          appendFileSync("tui-debug.log", `SUBMIT: ${JSON.stringify(result.values)}\n`);
          fn(result.values);
        }
        if (!editFormRef.current.active) setMode("list");
        return true;
      }
      if (modeRef.current === "confirm") {
        if (key.name === "y") {
          const t = deleteTargetRef.current;
          if (t) client.tasks.delete(t.id).then(() => refreshRef.current());
          setDeleteTarget(null);
          setMode("list");
          return true;
        }
        if (key.name === "n" || key.name === "escape") {
          setDeleteTarget(null);
          setMode("list");
          return true;
        }
        return true;
      }
      if (filterHandleKey(key)) return true;
      if (modeRef.current === "list" && !filterActiveRef.current) {
        if (vimHandleKey(key)) return true;
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
          editFormRef.current.open(taskFields());
          setMode("create");
          return true;
        }
        if (key.name === "e") {
          const t = filteredRef.current[cursorRef.current];
          if (t) {
            editFormRef.current.open(taskFields(t));
            setMode("edit");
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
          setMode("list");
          setDetail(null);
          return true;
        }
        if (key.name === "e" && detailRef.current) {
          editFormRef.current.open(taskFields(detailRef.current));
          setMode("edit");
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
    [filterHandleKey, vimHandleKey],
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

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={2} marginBottom={0} paddingLeft={1}>
        <text fg={colors.text}>{"TASKS"}</text>
        <text fg={colors.textDim}>{loading ? "loading…" : `${filtered.length} tasks`}</text>
        {query && <text fg={colors.accent}>{`/${query}`}</text>}
      </box>
      <ResourceTable columns={columns} data={filtered} cursor={cursor} keyFn={(t) => t.id} />
      <EditFormOverlay
        title={mode === "create" ? "New Task" : "Edit Task"}
        fields={editForm.fields}
        focusIdx={editForm.focusIdx}
        editing={editForm.editing}
        active={mode === "edit" || mode === "create"}
      />
      <ConfirmDialog
        message={deleteTarget ? `Delete task "${deleteTarget.title}"?` : ""}
        active={mode === "confirm"}
      />
    </box>
  );
}
