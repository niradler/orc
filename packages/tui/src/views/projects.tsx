import { createOrcClient } from "@orc/sdk";
import type { Project, ProjectSummary } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { DetailPane } from "../components/detail-pane.js";
import { EditFormOverlay, type FormField, useEditForm } from "../components/edit-form.js";
import { ResourceTable } from "../components/resource-table.js";
import { ViewToolbar } from "../components/view-toolbar.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors, projectStatusColor, statusIcon } from "../theme.js";
import type { Column, KeyEvent, SelectOption, ViewKeyHandler, ViewState } from "../types.js";

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

const PROJECT_STATUS_OPTIONS: SelectOption[] = [
  { label: "Active", value: "active" },
  { label: "Paused", value: "paused" },
  { label: "Archived", value: "archived" },
];

function projectFields(p?: Project): FormField[] {
  return [
    {
      key: "name",
      label: "Name",
      value: p?.name ?? "",
      placeholder: "my-project",
    },
    {
      key: "description",
      label: "Description",
      value: p?.description ?? "",
      type: "textarea",
      height: 6,
      placeholder: "What this project is for",
    },
    {
      key: "status",
      label: "Status",
      value: p?.status ?? "active",
      type: "select",
      options: PROJECT_STATUS_OPTIONS,
    },
    {
      key: "tags",
      label: "Tags",
      value: p?.tags?.join(", ") ?? "",
      placeholder: "backend, gateway, mcp",
    },
  ];
}

type Props = {
  onSelectProject: (name: string) => void;
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
  onStateChange: (state: ViewState) => void;
};

export function ProjectsView({ onSelectProject, onRegisterKeyHandler, onStateChange }: Props) {
  const [mode, setMode] = useState<"browse" | "detail" | "form" | "confirm">("browse");
  const [detail, setDetail] = useState<ProjectSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [formIntent, setFormIntent] = useState<"create" | "edit">("create");
  const [formTarget, setFormTarget] = useState<Project | null>(null);
  const editForm = useEditForm();

  const { data, loading, error, refresh } = usePolling(() => client.projects.list(), 5000);
  const projects = data?.projects ?? [];
  const {
    filtered,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(
    projects,
    (p) => `${p.name} ${p.description ?? ""} ${p.status} ${p.tags?.join(" ") ?? ""}`,
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
    const selectedProject = filtered[cursor];
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Projects",
      countLabel: loading ? "Loading projects…" : `${filtered.length} visible projects`,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode === "form" || mode === "confirm",
      selectionLabel:
        mode === "detail" && detail
          ? `Project detail • ${detail.project.name}`
          : selectedProject
            ? `${statusIcon(selectedProject.status)} ${selectedProject.status} • ${selectedProject.name}`
            : "Choose a project to scope tasks, jobs, and memories.",
      detailId: mode === "detail" ? (detail?.project.id ?? null) : null,
      statusMessage: "Press s to set the active project filter.",
    });
  }, [mode, query, filterActive, onStateChange, filtered, cursor, detail, loading]);

  const doCreate = useCallback((vals: Record<string, string>) => {
    if (!vals.name) return;
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    client.projects
      .create({
        name: vals.name,
        ...(vals.description ? { description: vals.description } : {}),
        status: (vals.status as Project["status"]) || "active",
        ...(tags ? { tags } : {}),
      })
      .then(() => refreshRef.current());
  }, []);

  const doEdit = useCallback((vals: Record<string, string>) => {
    const p = formTargetRef.current ?? filteredRef.current[cursorRef.current];
    if (!p) return;
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    client.projects
      .update(p.id, {
        ...(vals.name ? { name: vals.name } : {}),
        description: vals.description || null,
        ...(vals.status ? { status: vals.status as Project["status"] } : {}),
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
        if (key.name === "escape" || key.name === "return") {
          setFilterActive(false);
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
          if (formIntentRef.current === "create") doCreateRef.current(result.values);
          else doEditRef.current(result.values);
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
          const p = deleteTargetRef.current;
          if (p) client.projects.delete(p.id).then(() => refreshRef.current());
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
          setFormIntent("create");
          setFormTarget(null);
          editFormRef.current.open(projectFields());
          setMode("form");
          return true;
        }
        if (key.name === "e") {
          const p = filteredRef.current[cursorRef.current];
          if (p) {
            setFormIntent("edit");
            setFormTarget(p);
            editFormRef.current.open(projectFields(p));
            setMode("form");
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
      if (modeRef.current === "detail") {
        if (key.name === "escape") {
          setMode("browse");
          setDetail(null);
          return true;
        }
        if (key.name === "e" && detailRef.current) {
          setFormIntent("edit");
          setFormTarget(detailRef.current.project);
          editFormRef.current.open(projectFields(detailRef.current.project));
          setMode("form");
          return true;
        }
        if (key.name === "d" && detailRef.current) {
          setDeleteTarget(detailRef.current.project);
          setMode("confirm");
          return true;
        }
        return false;
      }
      return false;
    },
    [vimHandleKey, onSelectProject, setFilterActive],
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
      <ViewToolbar
        title="Projects"
        countLabel={loading ? "Loading projects…" : `${filtered.length} visible projects`}
        filterQuery={query}
        filterActive={filterActive}
        filterPlaceholder="Search by name, status, description, or tags"
        onFilterChange={setQuery}
        onFilterSubmit={() => setFilterActive(false)}
        statusMessage="Press s to select an active project"
      />
      <ResourceTable
        columns={columns}
        data={filtered}
        cursor={cursor}
        keyFn={(p) => p.id}
        loading={loading}
        error={error}
        emptyMessage="No projects created yet."
        filteredEmptyMessage="No projects match the current search."
        hasActiveFilter={Boolean(query)}
        selectedSummary={
          filtered[cursor]
            ? `${statusIcon(filtered[cursor]?.status ?? "")} ${filtered[cursor]?.status} • ${filtered[cursor]?.name}`
            : "Create a project with n, then press s to scope the rest of the TUI."
        }
      />
      <EditFormOverlay
        title={formIntent === "create" ? "New Project" : "Edit Project"}
        fields={editForm.fields}
        focusIdx={editForm.focusIdx}
        active={mode === "form"}
        onChange={editForm.updateValue}
      />
      <ConfirmDialog
        message={deleteTarget ? `Delete project "${deleteTarget.name}"?` : ""}
        active={mode === "confirm"}
      />
    </box>
  );
}
