import { useKeyboard } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import type { Project, ProjectSummary } from "@orc/sdk/types";
import { useCallback, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
import { ResourceTable } from "../components/resource-table.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors, projectStatusColor, statusIcon } from "../theme.js";
import type { Column, ViewMode } from "../types.js";

const client = createOrcClient();

const columns: Column<Project>[] = [
  {
    key: "status",
    label: "Status",
    width: 10,
    render: (p) => `${statusIcon(p.status)} ${p.status}`,
    color: (p) => projectStatusColor[p.status] ?? colors.text,
  },
  { key: "name", label: "Name", width: 20, render: (p) => p.name },
  {
    key: "desc",
    label: "Description",
    width: 40,
    render: (p) => p.description ?? "—",
    color: () => colors.textDim,
  },
  {
    key: "tags",
    label: "Tags",
    width: 20,
    render: (p) => (p.tags?.length ? p.tags.join(", ") : "—"),
    color: () => colors.textDim,
  },
];

type Props = {
  onSelectProject: (name: string) => void;
};

export function ProjectsView({ onSelectProject }: Props) {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<ProjectSummary | null>(null);

  const { data, loading, refresh } = usePolling(() => client.projects.list(), 5000);

  const projects = data?.projects ?? [];

  const {
    filtered,
    query,
    active: filterActive,
  } = useFilter(projects, (p) => `${p.name} ${p.description ?? ""} ${p.status}`, mode === "list");

  const { cursor } = useVimList(filtered.length, mode === "list" && !filterActive);

  const openDetail = useCallback(async () => {
    const project = filtered[cursor];
    if (!project) return;
    const result = await client.projects.summary(project.id);
    if (result.data) {
      setDetail(result.data);
      setMode("detail");
    }
  }, [filtered, cursor]);

  useKeyboard((key) => {
    if (mode === "list" && !filterActive) {
      if (key.name === "return") openDetail();
      if (key.name === "r") refresh();
      if (key.name === "s") {
        const p = filtered[cursor];
        if (p) onSelectProject(p.name);
      }
    }
    if (mode === "detail" && key.name === "escape") {
      setMode("list");
      setDetail(null);
    }
  });

  if (mode === "detail" && detail) {
    const p = detail.project;
    const fields = [
      { label: "ID", value: p.id, color: colors.textDim },
      { label: "Name", value: p.name },
      {
        label: "Status",
        value: `${statusIcon(p.status)} ${p.status}`,
        color: projectStatusColor[p.status] ?? colors.text,
      },
      { label: "Description", value: p.description ?? "—" },
      { label: "Scope", value: p.scope ?? "—" },
      { label: "Tags", value: p.tags?.join(", ") ?? "—" },
      {
        label: "Tasks",
        value: Object.entries(detail.tasks.by_status)
          .map(([s, n]) => `${s}:${n}`)
          .join("  "),
      },
      { label: "Memories", value: String(detail.memories) },
      { label: "Jobs", value: String(detail.jobs) },
      { label: "Created", value: p.created_at },
    ];
    return <DetailPane title={`Project: ${p.name}`} fields={fields} />;
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={2} marginBottom={0} paddingLeft={1}>
        <text fg={colors.text}>{"PROJECTS"}</text>
        <text fg={colors.textDim}>{loading ? "loading…" : `${filtered.length} projects`}</text>
        {query && <text fg={colors.accent}>{`/${query}`}</text>}
      </box>
      <ResourceTable columns={columns} data={filtered} cursor={cursor} keyFn={(p) => p.id} />
    </box>
  );
}
