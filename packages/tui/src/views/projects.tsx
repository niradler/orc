import { createOrcClient } from "@orc/sdk";
import type { Project, ProjectSummary } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { DetailPane } from "../components/detail-pane.js";
import { EditFormOverlay, type FormField, useEditForm } from "../components/edit-form.js";
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

function projectFields(p?: Project): FormField[] {
  return [
    { key: "name", label: "Name", value: p?.name ?? "" },
    { key: "description", label: "Description", value: p?.description ?? "" },
    {
      key: "status",
      label: "Status",
      value: p?.status ?? "active",
      options: ["active", "archived", "paused"],
    },
    { key: "tags", label: "Tags", value: p?.tags?.join(", ") ?? "" },
  ];
}

type Props = {
  onSelectProject: (name: string) => void;
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
};

export function ProjectsView({ onSelectProject, onRegisterKeyHandler }: Props) {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<ProjectSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const editForm = useEditForm();

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
  const editFormRef = useRef(editForm);
  editFormRef.current = editForm;
  const deleteTargetRef = useRef(deleteTarget);
  deleteTargetRef.current = deleteTarget;

  const submitCreate = useCallback(async (vals: Record<string, string>) => {
    if (!vals.name) return;
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    await client.projects.create({
      name: vals.name,
      ...(vals.description ? { description: vals.description } : {}),
      status: (vals.status as Project["status"]) || "active",
      ...(tags ? { tags } : {}),
    });
    setMode("list");
    refreshRef.current();
  }, []);

  const submitEdit = useCallback(async (vals: Record<string, string>) => {
    const p = filteredRef.current[cursorRef.current];
    if (!p) return;
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    await client.projects.update(p.id, {
      ...(vals.name ? { name: vals.name } : {}),
      description: vals.description || null,
      ...(vals.status ? { status: vals.status as Project["status"] } : {}),
      tags,
    });
    setMode("list");
    refreshRef.current();
  }, []);

  const submitCreateRef = useRef(submitCreate);
  submitCreateRef.current = submitCreate;
  const submitEditRef = useRef(submitEdit);
  submitEditRef.current = submitEdit;

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (modeRef.current === "edit" || modeRef.current === "create") {
        const onSubmit =
          modeRef.current === "create" ? submitCreateRef.current : submitEditRef.current;
        editFormRef.current.handleKey(key, onSubmit);
        if (!editFormRef.current.active) setMode("list");
        return true;
      }
      if (modeRef.current === "confirm") {
        if (key.name === "y") {
          const p = deleteTargetRef.current;
          if (p) client.projects.delete(p.id).then(() => refreshRef.current());
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
          const p = filteredRef.current[cursorRef.current];
          if (p)
            client.projects.summary(p.id).then((r) => {
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
        if (key.name === "s") {
          const p = filteredRef.current[cursorRef.current];
          if (p) onSelectProject(p.name);
          return true;
        }
        if (key.name === "n") {
          editFormRef.current.open(projectFields());
          setMode("create");
          return true;
        }
        if (key.name === "e") {
          const p = filteredRef.current[cursorRef.current];
          if (p) {
            editFormRef.current.open(projectFields(p));
            setMode("edit");
          }
          return true;
        }
        if (key.name === "d") {
          const p = filteredRef.current[cursorRef.current];
          if (p) {
            setDeleteTarget(p);
            setMode("confirm");
          }
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
      <EditFormOverlay
        title={mode === "create" ? "New Project" : "Edit Project"}
        fields={editForm.fields}
        focusIdx={editForm.focusIdx}
        editing={editForm.editing}
        active={mode === "edit" || mode === "create"}
      />
      <ConfirmDialog
        message={deleteTarget ? `Delete project "${deleteTarget.name}"?` : ""}
        active={mode === "confirm"}
      />
    </box>
  );
}
