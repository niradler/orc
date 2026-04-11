import { createOrcClient } from "@orc/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { useSort } from "../hooks/use-sort.js";
import { useVimList } from "../hooks/use-vim-list.js";
import {
  handleDetailEscapeKey,
  handleFilterInputKey,
  isFilterToggleKey,
  isOpenDetailKey,
  isRefreshKey,
} from "../navigation.js";
import { colors } from "../theme.js";
import type { Column, KeyEvent, PaletteCommand, ViewKeyHandler, ViewState } from "../types.js";

const client = createOrcClient();

type KnowledgeCollection = {
  name: string;
  path: string;
  pattern: string;
  documentCount: number;
  lastModified: string | null;
  projectId: string | null;
};

const columns: Column<KnowledgeCollection>[] = [
  {
    key: "name",
    label: "Collection",
    width: 20,
    minWidth: 10,
    priority: 8,
    render: (c) => c.name,
    sortValue: (c) => c.name.toLowerCase(),
  },
  {
    key: "documentCount",
    label: "Docs",
    width: 8,
    minWidth: 6,
    priority: 7,
    render: (c) => String(c.documentCount),
    sortValue: (c) => c.documentCount,
  },
  {
    key: "pattern",
    label: "Pattern",
    width: 16,
    minWidth: 10,
    priority: 5,
    render: (c) => c.pattern,
    color: () => colors.textDim,
  },
  {
    key: "path",
    label: "Path",
    width: 40,
    minWidth: 16,
    priority: 6,
    render: (c) => c.path,
    color: () => colors.textDim,
    sortValue: (c) => c.path.toLowerCase(),
  },
  {
    key: "lastModified",
    label: "Updated",
    width: 12,
    minWidth: 10,
    priority: 3,
    render: (c) => c.lastModified?.slice(0, 10) ?? "—",
    color: () => colors.textDim,
    sortValue: (c) => c.lastModified ?? "",
  },
];

function collectionFields(): FormField[] {
  return [
    {
      key: "name",
      label: "Name",
      value: "",
      placeholder: "e.g. docs, notes, wiki",
    },
    {
      key: "path",
      label: "Path",
      value: "",
      placeholder: "Absolute path to directory",
    },
    {
      key: "pattern",
      label: "Pattern",
      value: "**/*.md",
      placeholder: "Glob pattern (default: **/*.md)",
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

export function KnowledgeView({
  projectId,
  onRegisterKeyHandler,
  onStateChange,
  onRegisterCommands,
  onRegisterSearch,
}: Props) {
  const [mode, setMode] = useState<"browse" | "detail" | "form" | "confirm">("browse");
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeCollection | null>(null);
  const editForm = useEditForm();
  const { sort, setSortByKey, toggleDirection, sortData } = useSort(columns);

  const fetchCollections = useCallback(
    () => client.knowledge.collections(projectId ? { project_id: projectId } : undefined),
    [projectId],
  );
  const { data, loading, error, refresh, mutate } = usePolling(fetchCollections, 5000);
  const collections = data?.collections ?? [];
  const {
    filtered: filteredUnsorted,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(collections, (c) => `${c.name} ${c.path} ${c.pattern}`, true);
  const filtered = sortData(filteredUnsorted);
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
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;
  const editFormRef = useRef(editForm);
  editFormRef.current = editForm;
  const deleteTargetRef = useRef(deleteTarget);
  deleteTargetRef.current = deleteTarget;

  useEffect(() => {
    const selected = filtered[cursor];
    const sortLabel = sort.key ? `${sort.key} ${sort.direction === "asc" ? "▲" : "▼"}` : null;
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Knowledge",
      countLabel: loading ? "Loading collections…" : `${filtered.length} collections`,
      sortLabel,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode !== "browse",
      selectionLabel: selected
        ? `${selected.name} • ${selected.documentCount} docs`
        : "No collection selected.",
      detailId: null,
      statusMessage: null,
      contextData: selected ? JSON.stringify(selected, null, 2) : null,
    });
  }, [mode, query, filterActive, onStateChange, filtered, cursor, loading, sort]);

  useEffect(() => {
    const sortCommands: PaletteCommand[] = columns
      .filter((c) => c.sortValue)
      .map((col) => ({
        id: `sort-${col.key}`,
        name: `Sort by ${col.label}`,
        category: "sort" as const,
        aliases: [`sort ${col.key}`, `sort ${col.label.toLowerCase()}`],
        icon: "↕",
        ...(sort.key === col.key
          ? { hint: `${sort.direction === "asc" ? "▲" : "▼"} current` }
          : {}),
        available: () => modeRef.current === "browse",
        execute: () => setSortByKey(col.key),
      }));

    onRegisterCommands(sortCommands);
  }, [onRegisterCommands, setSortByKey, sort]);

  useEffect(() => {
    onRegisterSearch({ setQuery, clear: () => setQuery("") });
  }, [onRegisterSearch, setQuery]);

  const doCreate = useCallback(
    async (vals: Record<string, string>) => {
      if (!vals.name) throw new Error("Name is required.");
      if (!vals.path) throw new Error("Path is required.");
      const result = await client.knowledge.addCollection({
        name: vals.name,
        path: vals.path,
        pattern: vals.pattern || "**/*.md",
        ...(projectId ? { project_id: projectId } : {}),
      });
      if (result.error) throw new Error(result.error.error);
      return result.data;
    },
    [projectId],
  );

  const doCreateRef = useRef(doCreate);
  doCreateRef.current = doCreate;

  const submitCurrentForm = useCallback(async () => {
    const result = editFormRef.current.submit();
    if (!editFormRef.current.beginSubmit("Adding collection…")) return;
    try {
      await doCreateRef.current(result.values);
      editFormRef.current.finishSubmit("success", "Collection added.");
      setTimeout(() => {
        editFormRef.current.close();
        refreshRef.current();
        setMode("browse");
      }, 700);
    } catch (err) {
      editFormRef.current.finishSubmit("error", formErrorMessage(err, "Couldn't add collection."));
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
          const target = deleteTargetRef.current;
          if (target)
            client.knowledge.removeCollection(target.name).then(() => refreshRef.current());
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
          const c = filteredRef.current[cursorRef.current];
          if (c) {
            setMode("detail");
          }
          return true;
        }
        if (key.name === "s") {
          toggleDirection();
          return true;
        }
        if (isRefreshKey(key.name)) {
          refreshRef.current();
          return true;
        }
        if (key.name === "a" || key.name === "n") {
          editFormRef.current.open(collectionFields());
          setMode("form");
          return true;
        }
        if (key.name === "d") {
          const c = filteredRef.current[cursorRef.current];
          if (c) {
            setDeleteTarget(c);
            setMode("confirm");
          }
          return true;
        }
      }

      if (modeRef.current === "detail") {
        if (
          handleDetailEscapeKey(key.name, () => {
            setMode("browse");
          })
        )
          return true;
        if (key.name === "d") {
          const c = filteredRef.current[cursorRef.current];
          if (c) {
            setDeleteTarget(c);
            setMode("confirm");
          }
          return true;
        }
        return false;
      }
      return false;
    },
    [submitCurrentForm, vimHandleKey, setFilterActive, toggleDirection],
  );

  useEffect(() => {
    onRegisterKeyHandler(handleKey);
  }, [handleKey, onRegisterKeyHandler]);

  if (mode === "detail") {
    const c = filtered[cursor];
    if (c) {
      const fields = [
        { label: "Name", value: c.name },
        { label: "Path", value: c.path },
        { label: "Pattern", value: c.pattern },
        { label: "Documents", value: String(c.documentCount) },
        { label: "Last Modified", value: c.lastModified ?? "—" },
      ];
      return (
        <DetailPane
          title="Knowledge Collection"
          fields={fields}
          body={`Collection "${c.name}" indexes ${c.documentCount} documents from ${c.path} matching ${c.pattern}.`}
          hint="Esc back • d delete"
        />
      );
    }
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <ViewToolbar
        title="Knowledge"
        countLabel={loading ? "Loading…" : `${filtered.length} collections`}
        filterQuery={query}
        filterActive={filterActive}
        filterPlaceholder="Search collections by name or path"
        onFilterChange={setQuery}
        onFilterSubmit={() => setFilterActive(false)}
        statusMessage="Document collections indexed for search"
      />
      <ResourceTable
        columns={columns}
        data={filtered}
        cursor={cursor}
        keyFn={(c) => c.name}
        loading={loading}
        error={error}
        emptyMessage="No knowledge collections. Press a to add one."
        filteredEmptyMessage="No collections match the search."
        hasActiveFilter={Boolean(query)}
        sort={sort}
        selectedSummary={
          filtered[cursor]
            ? `${filtered[cursor]?.name} • ${filtered[cursor]?.documentCount} docs`
            : "Add a document collection with a."
        }
      />
      {mode === "form" && (
        <EditFormOverlay
          title="Add Collection"
          fields={editForm.fields}
          focusIdx={editForm.focusIdx}
          onChange={editForm.updateValue}
          submitState={editForm.submitState}
          onSubmit={submitCurrentForm}
          onCancel={() => {
            if (editForm.submitState.status === "saving") return;
            editForm.close();
            setMode("browse");
          }}
          onNextField={editForm.nextField}
          onPrevField={editForm.prevField}
        />
      )}
      {mode === "confirm" && deleteTarget && (
        <ConfirmDialog message={`Remove collection "${deleteTarget.name}"?`} />
      )}
    </box>
  );
}
