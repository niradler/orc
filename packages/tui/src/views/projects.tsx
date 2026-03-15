import { createOrcClient } from "@orc/sdk";
import type { Project, ProjectSummary } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
import { ResourceTable } from "../components/resource-table.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors, projectStatusColor, statusIcon } from "../theme.js";
import type { Column, KeyEvent, ViewKeyHandler, ViewMode } from "../types.js";

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
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
};

export function ProjectsView({ onSelectProject, onRegisterKeyHandler }: Props) {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<ProjectSummary | null>(null);

  const { data, loading, refresh } = usePolling(() => client.projects.list(), 5000);
  const projects = data?.projects ?? [];

  const {
    filtered,
    query,
    active: filterActive,
    handleKey: filterHandleKey,
  } = useFilter(projects, (p) => `${p.name} ${p.description ?? ""} ${p.status}`, mode === "list");

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
          const project = filteredRef.current[cursorRef.current];
          if (project) {
            client.projects.summary(project.id).then((result) => {
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
        if (key.name === "s") {
          const p = filteredRef.current[cursorRef.current];
          if (p) onSelectProject(p.name);
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
    [filterHandleKey, vimHandleKey, onSelectProject],
  );

  useEffect(() => {
    onRegisterKeyHandler(handleKey);
  }, [handleKey, onRegisterKeyHandler]);

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
