import { createOrcClient } from "@orc/sdk";
import type { Task } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
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

type Props = {
  projectId: string | null;
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
};

export function TasksView({ projectId, onRegisterKeyHandler }: Props) {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<Task | null>(null);

  const { data, loading, refresh } = usePolling(
    () =>
      client.tasks.list({
        ...(projectId ? { project_id: projectId } : {}),
        limit: 100,
      }),
    5000,
  );

  const tasks = data?.tasks ?? [];

  const {
    filtered,
    query,
    active: filterActive,
    handleKey: filterHandleKey,
  } = useFilter(
    tasks,
    (t) => `${t.title} ${t.status} ${t.priority} ${t.id} ${t.author}`,
    mode === "list",
  );

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

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (filterHandleKey(key)) return true;

      if (modeRef.current === "list" && !filterActiveRef.current) {
        if (vimHandleKey(key)) return true;
        if (key.name === "return") {
          const task = filteredRef.current[cursorRef.current];
          if (task) {
            client.tasks.get(task.id).then((result) => {
              if (result.data) {
                setDetail(result.data);
                setMode("detail");
              }
            });
          }
          return true;
        }
        if (key.name === "r") {
          refreshRef.current();
          return true;
        }
      }
      if (modeRef.current === "detail" && key.name === "escape") {
        setMode("list");
        setDetail(null);
        return true;
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
      <DetailPane title={`Task: ${detail.title}`} fields={fields} body={detail.body ?? undefined} />
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
    </box>
  );
}
