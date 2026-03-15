import { useKeyboard } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import type { Task } from "@orc/sdk/types";
import { useCallback, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
import { ResourceTable } from "../components/resource-table.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors, priorityColor, statusColor, statusIcon } from "../theme.js";
import type { Column, ViewMode } from "../types.js";

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
  {
    key: "id",
    label: "ID",
    width: 10,
    render: (t) => t.id.slice(-6),
    color: () => colors.textDim,
  },
  { key: "title", label: "Title", width: 50, render: (t) => t.title },
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
};

export function TasksView({ projectId }: Props) {
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
  } = useFilter(
    tasks,
    (t) => `${t.title} ${t.status} ${t.priority} ${t.id} ${t.author}`,
    mode === "list",
  );

  const { cursor } = useVimList(filtered.length, mode === "list" && !filterActive);

  const openDetail = useCallback(async () => {
    const task = filtered[cursor];
    if (!task) return;
    const result = await client.tasks.get(task.id);
    if (result.data) {
      setDetail(result.data);
      setMode("detail");
    }
  }, [filtered, cursor]);

  useKeyboard((key) => {
    if (mode === "list" && !filterActive) {
      if (key.name === "return") openDetail();
      if (key.name === "r") refresh();
    }
    if (mode === "detail" && key.name === "escape") {
      setMode("list");
      setDetail(null);
    }
  });

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
