import { createOrcClient } from "@orc/sdk";
import type { Project, ProjectSummary } from "@orc/sdk/types";
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
import { colors, projectStatusColor, statusIcon } from "../theme.js";
import type { Column, KeyEvent, SelectOption, ViewKeyHandler, ViewState } from "../types.js";

const client = createOrcClient();

const columns: Column<Project>[] = [
  {
    key: "status",
    label: "Status",
    width: 10,
    minWidth: 8,
    priority: 7,
    render: (p) => `${statusIcon(p.status)} ${p.status}`,
    color: (p) => projectStatusColor[p.status] ?? colors.text,
    sortValue: (p) => p.status,
  },
  {
    key: "name",
    label: "Name",
    width: 20,
    minWidth: 14,
    priority: 8,
    render: (p) => p.name,
    sortValue: (p) => p.name.toLowerCase(),
  },
  {
    key: "desc",
    label: "Description",
    width: 40,
    minWidth: 16,
    priority: 5,
    render: (p) => p.description ?? "—",
    color: () => colors.textDim,
  },
  {
    key: "tags",
    label: "Tags",
    width: 20,
    minWidth: 10,
    priority: 3,
    render: (p) => (p.tags?.length ? p.tags.join(", ") : "—"),
    color: () => colors.textDim,
  },
  {
    key: "updated_at",
    label: "Updated",
    width: 12,
    minWidth: 10,
    priority: 1,
    render: (p) => p.updated_at.slice(0, 10),
    color: () => colors.textDim,
    sortValue: (p) => p.updated_at,
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
  const { sort, cycleSort, sortData } = useSort(columns);

  const { data, loading, error, refresh, mutate } = usePolling(() => client.projects.list(), 5000);
  const projects = data?.projects ?? [];
  const {
    filtered: filteredUnsorted,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(
    projects,
    (p) => `${p.name} ${p.description ?? ""} ${p.status} ${p.tags?.join(" ") ?? ""}`,
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
    const selectedProject = filtered[cursor];
    const sortLabel = sort.key ? `sorted:${sort.key}` : "";
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Projects",
      countLabel: loading
        ? "Loading projects…"
        : `${filtered.length} projects${sortLabel ? ` • ${sortLabel}` : ""}`,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode !== "browse",
      selectionLabel: selectedProject
        ? `${statusIcon(selectedProject.status)} ${selectedProject.status} • ${selectedProject.name}`
        : "Choose a project to scope tasks, jobs, and memories.",
      detailId: mode === "detail" ? (detail?.project.id ?? null) : null,
      statusMessage: null,
      contextData:
        mode === "detail" && detail
          ? JSON.stringify(detail, null, 2)
          : filtered[cursor]
            ? JSON.stringify(filtered[cursor], null, 2)
            : null,
    });
  }, [mode, query, filterActive, onStateChange, filtered, cursor, detail, loading, sort]);

  const doCreate = useCallback(async (vals: Record<string, string>) => {
    if (!vals.name) throw new Error("Project name is required.");
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const created = await client.projects.create({
      name: vals.name,
      ...(vals.description ? { description: vals.description } : {}),
      status: (vals.status as Project["status"]) || "active",
      ...(tags ? { tags } : {}),
    });
    return expectApiData(created, "Couldn't create project.");
  }, []);

  const doEdit = useCallback(async (vals: Record<string, string>) => {
    const p = formTargetRef.current ?? filteredRef.current[cursorRef.current];
    if (!p) throw new Error("Select a project first.");
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    const updated = await client.projects.update(p.id, {
      ...(vals.name ? { name: vals.name } : {}),
      description: vals.description || null,
      ...(vals.status ? { status: vals.status as Project["status"] } : {}),
      tags,
    });
    return expectApiData(updated, "Couldn't save project.");
  }, []);

  const doCreateRef = useRef(doCreate);
  doCreateRef.current = doCreate;
  const doEditRef = useRef(doEdit);
  doEditRef.current = doEdit;

  const submitCurrentForm = useCallback(async () => {
    const result = editFormRef.current.submit();
    const creating = formIntentRef.current === "create";
    const action = creating ? doCreateRef.current : doEditRef.current;

    if (!editFormRef.current.beginSubmit(creating ? "Creating project…" : "Saving project…"))
      return;

    try {
      const savedProject = await action(result.values);
      if (savedProject && detailRef.current) {
        setDetail((current) =>
          current
            ? {
                ...current,
                project: savedProject,
              }
            : current,
        );
      }
      editFormRef.current.finishSubmit("success", creating ? "Project created." : "Project saved.");
      setTimeout(() => {
        editFormRef.current.close();
        setFormTarget(null);
        if (savedProject) {
          mutateRef.current((current) => {
            if (!current) return { projects: [savedProject] };
            if (creating) {
              return { projects: [savedProject, ...current.projects] };
            }
            return {
              projects: current.projects.map((p) => (p.id === savedProject.id ? savedProject : p)),
            };
          });
        }
        setMode("browse");
      }, 700);
    } catch (error) {
      editFormRef.current.finishSubmit("error", formErrorMessage(error, "Couldn't save project."));
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
        if (isFilterToggleKey(key.name)) {
          setFilterActive(true);
          return true;
        }
        if (isOpenDetailKey(key.name)) {
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
        if (isRefreshKey(key.name)) {
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
        if (key.name === "o") {
          cycleSort();
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
        if (key.name === "s" && detailRef.current) {
          onSelectProject(detailRef.current.project.name);
          return true;
        }
        return false;
      }
      return false;
    },
    [submitCurrentForm, vimHandleKey, onSelectProject, setFilterActive, cycleSort],
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
    return (
      <DetailPane
        title={`Project: ${p.name}`}
        fields={fields}
        hint="Esc back • e edit • d delete • s scope • Up/Down scroll"
      />
    );
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
        sort={sort}
        selectedSummary={
          filtered[cursor]
            ? `${statusIcon(filtered[cursor]?.status ?? "")} ${filtered[cursor]?.status} • ${filtered[cursor]?.name}`
            : "Create a project with n, then press s to scope the rest of the TUI."
        }
      />
      {mode === "form" && (
        <EditFormOverlay
          title={formIntent === "create" ? "New Project" : "Edit Project"}
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
        <ConfirmDialog message={`Delete project "${deleteTarget.name}"?`} />
      )}
    </box>
  );
}
