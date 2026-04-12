import { createOrcClient } from "@orc/sdk";
import type { Memory } from "@orc/sdk/types";
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
import { useSort } from "../hooks/use-sort.js";
import { useVimList } from "../hooks/use-vim-list.js";
import {
  handleDetailEscapeKey,
  handleFilterInputKey,
  isFilterToggleKey,
  isOpenDetailKey,
  isRefreshKey,
} from "../navigation.js";
import { colors, importanceColor } from "../theme.js";
import type {
  Column,
  KeyEvent,
  PaletteCommand,
  SelectOption,
  ViewKeyHandler,
  ViewState,
} from "../types.js";

const client = createOrcClient();

const IMPORTANCE_ORDER: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };

const columns: Column<Memory>[] = [
  {
    key: "importance",
    label: "Importance",
    width: 10,
    minWidth: 8,
    priority: 7,
    render: (m) => m.importance,
    color: (m) => importanceColor[m.importance] ?? colors.text,
    sortValue: (m) => IMPORTANCE_ORDER[m.importance] ?? 99,
  },
  {
    key: "scope",
    label: "Scope",
    width: 14,
    minWidth: 8,
    priority: 5,
    render: (m) => m.scope ?? "global",
    color: () => colors.textDim,
    sortValue: (m) => (m.scope ?? "global").toLowerCase(),
  },
  {
    key: "content",
    label: "Content",
    width: 60,
    minWidth: 18,
    priority: 8,
    render: (m) => (m.content.length > 58 ? `${m.content.slice(0, 58)}…` : m.content),
  },
  {
    key: "source",
    label: "Source",
    width: 12,
    minWidth: 8,
    priority: 3,
    render: (m) => m.source ?? "—",
    color: () => colors.textDim,
  },
  {
    key: "tags",
    label: "Tags",
    width: 16,
    minWidth: 10,
    priority: 2,
    render: (m) => m.tags?.join(", ") ?? "—",
    color: () => colors.textDim,
  },
  {
    key: "created",
    label: "Created",
    width: 12,
    minWidth: 10,
    priority: 4,
    render: (m) => m.created_at.slice(0, 10),
    color: () => colors.textDim,
    sortValue: (m) => m.created_at,
  },
  {
    key: "updated_at",
    label: "Updated",
    width: 12,
    minWidth: 10,
    priority: 1,
    render: (m) => m.updated_at.slice(0, 10),
    color: () => colors.textDim,
    sortValue: (m) => m.updated_at,
  },
];

function memoryFields(memory?: Memory): FormField[] {
  const typeOptions: SelectOption[] = [
    { label: "Fact", value: "fact" },
    { label: "Decision", value: "decision" },
    { label: "Event", value: "event" },
    { label: "Rule", value: "rule" },
    { label: "Discovery", value: "discovery" },
  ];
  const importanceOptions: SelectOption[] = [
    { label: "Low", value: "low" },
    { label: "Normal", value: "normal" },
    { label: "High", value: "high" },
    { label: "Critical", value: "critical" },
  ];
  const baseFields: FormField[] = [
    {
      key: "content",
      label: "Content",
      value: memory?.content ?? "",
      type: "textarea",
      height: 8,
      placeholder: "Store a fact, decision, rule, or discovery",
    },
    {
      key: "importance",
      label: "Importance",
      value: memory?.importance ?? "normal",
      type: "select",
      options: importanceOptions,
    },
    {
      key: "scope",
      label: "Scope",
      value: memory?.scope ?? "",
      placeholder: "global or subsystem",
    },
    {
      key: "source",
      label: "Source",
      value: memory?.source ?? "",
      placeholder: "agent, doc, discussion",
    },
    {
      key: "tags",
      label: "Tags",
      value: memory?.tags?.join(", ") ?? "",
      placeholder: "search, api, rule",
    },
  ];

  if (!memory) {
    baseFields.splice(1, 0, {
      key: "type",
      label: "Type",
      value: "fact",
      type: "select",
      options: typeOptions,
    });
  }

  return baseFields;
}

type Props = {
  projectId: string | null;
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
  onStateChange: (state: ViewState) => void;
  onRegisterCommands: (cmds: PaletteCommand[]) => void;
  onRegisterSearch: (fns: { setQuery: (q: string) => void; clear: () => void }) => void;
};

export function MemoriesView({
  projectId,
  onRegisterKeyHandler,
  onStateChange,
  onRegisterCommands,
  onRegisterSearch,
}: Props) {
  const [mode, setMode] = useState<"browse" | "detail" | "form" | "confirm">("browse");
  const [detail, setDetail] = useState<Memory | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null);
  const [formIntent, setFormIntent] = useState<"create" | "edit">("create");
  const [formTarget, setFormTarget] = useState<Memory | null>(null);
  const editForm = useEditForm();
  const { sort, setSortByKey, toggleDirection, sortData } = useSort(columns);

  const { data, loading, error, refresh, mutate } = usePolling(
    () => client.memories.list({ ...(projectId ? { project_id: projectId } : {}), limit: 100 }),
    5000,
  );
  const memories = data?.memories ?? [];
  const {
    filtered: filteredUnsorted,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(
    memories,
    (m) => `${m.content} ${m.scope ?? ""} ${m.importance} ${m.tags?.join(" ") ?? ""}`,
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
    const selectedMemory = filtered[cursor];
    const sortLabel = sort.key ? `${sort.key} ${sort.direction === "asc" ? "▲" : "▼"}` : null;
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Memories",
      countLabel: loading ? "Loading memories…" : `${filtered.length} memories`,
      sortLabel,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode !== "browse",
      selectionLabel: selectedMemory
        ? `${selectedMemory.importance} • ${(selectedMemory.scope ?? "global").toString()}`
        : "No memory selected yet.",
      detailId: mode === "detail" ? (detail?.id ?? null) : null,
      statusMessage: null,
      contextData:
        mode === "detail" && detail
          ? JSON.stringify(detail, null, 2)
          : filtered[cursor]
            ? JSON.stringify(filtered[cursor], null, 2)
            : null,
    });
  }, [mode, query, filterActive, onStateChange, filtered, cursor, detail, loading, sort]);

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

    const filterCommands: PaletteCommand[] = [];
    const importances = [...new Set(memories.map((m) => m.importance))];
    for (const i of importances) {
      filterCommands.push({
        id: `filter-importance-${i}`,
        name: `Filter importance: ${i}`,
        category: "filter",
        aliases: [`filter importance ${i}`, `filter importance=${i}`, i],
        icon: "◆",
        ...(query === i ? { hint: "active" } : {}),
        available: () => modeRef.current === "browse",
        execute: () => setQuery(i),
      });
    }
    const scopes = [...new Set(memories.map((m) => m.scope ?? "global"))];
    for (const s of scopes) {
      filterCommands.push({
        id: `filter-scope-${s}`,
        name: `Filter scope: ${s}`,
        category: "filter",
        aliases: [`filter scope ${s}`, `filter scope=${s}`, s],
        icon: "◎",
        ...(query === s ? { hint: "active" } : {}),
        available: () => modeRef.current === "browse",
        execute: () => setQuery(s),
      });
    }
    const sources = [...new Set(memories.map((m) => m.source).filter(Boolean))];
    for (const s of sources) {
      filterCommands.push({
        id: `filter-source-${s}`,
        name: `Filter source: ${s}`,
        category: "filter",
        aliases: [`filter source ${s}`, `filter source=${s}`, s!],
        icon: "◇",
        available: () => modeRef.current === "browse",
        execute: () => setQuery(s!),
      });
    }
    filterCommands.push({
      id: "filter-clear",
      name: "Clear filter",
      category: "filter",
      aliases: ["filter clear", "filter reset", "clear filter"],
      icon: "✕",
      ...(query ? { hint: `filtering: "${query}"` } : {}),
      available: () => modeRef.current === "browse",
      execute: () => setQuery(""),
    });

    onRegisterCommands([...sortCommands, ...filterCommands]);
  }, [onRegisterCommands, setSortByKey, sort, memories, query, setQuery]);

  useEffect(() => {
    onRegisterSearch({ setQuery, clear: () => setQuery("") });
  }, [onRegisterSearch, setQuery]);

  const doCreate = useCallback(
    async (vals: Record<string, string>) => {
      if (!vals.content) throw new Error("Content is required.");
      const tags = vals.tags
        ? vals.tags
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const created = await client.memories.create({
        content: vals.content,
        type: (vals.type as "fact" | "decision" | "event" | "rule" | "discovery") || "fact",
        importance: (vals.importance as "low" | "normal" | "high" | "critical") || "normal",
        ...(vals.scope ? { scope: vals.scope } : {}),
        ...(tags ? { tags } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      });
      return expectApiData(created, "Couldn't create memory.");
    },
    [projectId],
  );

  const doCreateRef = useRef(doCreate);
  doCreateRef.current = doCreate;
  const doEdit = useCallback(async (vals: Record<string, string>) => {
    const memory = formTargetRef.current ?? detailRef.current;
    if (!memory) throw new Error("Select a memory first.");
    if (!vals.content) throw new Error("Content is required.");
    const tags = vals.tags
      ? vals.tags
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const updated = await client.memories.update(memory.id, {
      content: vals.content,
      ...(vals.source ? { source: vals.source } : {}),
      ...(vals.scope ? { scope: vals.scope } : {}),
      tags,
      importance: (vals.importance as "low" | "normal" | "high" | "critical") || memory.importance,
    });
    return expectApiData(updated, "Couldn't save memory.");
  }, []);
  const doEditRef = useRef(doEdit);
  doEditRef.current = doEdit;

  const submitCurrentForm = useCallback(async () => {
    const result = editFormRef.current.submit();
    const creating = formIntentRef.current === "create";
    const action = creating ? doCreateRef.current : doEditRef.current;

    if (!editFormRef.current.beginSubmit(creating ? "Creating memory…" : "Saving memory…")) return;

    try {
      const savedMemory = await action(result.values);
      if (savedMemory) setDetail(savedMemory);
      editFormRef.current.finishSubmit("success", creating ? "Memory created." : "Memory saved.");
      setTimeout(() => {
        editFormRef.current.close();
        setFormTarget(null);
        if (savedMemory) {
          mutateRef.current((current) => {
            if (!current) return { memories: [savedMemory] };
            if (creating) {
              return { memories: [savedMemory, ...current.memories] };
            }
            return {
              memories: current.memories.map((m) => (m.id === savedMemory.id ? savedMemory : m)),
            };
          });
        }
        setMode("browse");
      }, 700);
    } catch (error) {
      editFormRef.current.finishSubmit("error", formErrorMessage(error, "Couldn't save memory."));
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
          const m = deleteTargetRef.current;
          if (m) client.memories.delete(m.id).then(() => refreshRef.current());
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
          const m = filteredRef.current[cursorRef.current];
          if (m) {
            setDetail(m);
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
        if (key.name === "n") {
          setFormIntent("create");
          setFormTarget(null);
          editFormRef.current.open(memoryFields());
          setMode("form");
          return true;
        }
        if (key.name === "e") {
          const m = filteredRef.current[cursorRef.current];
          if (m) {
            setFormIntent("edit");
            setFormTarget(m);
            editFormRef.current.open(memoryFields(m));
            setMode("form");
          }
          return true;
        }
        if (key.name === "d") {
          const m = filteredRef.current[cursorRef.current];
          if (m) {
            setDeleteTarget(m);
            setMode("confirm");
          }
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
        if (key.name === "d" && detailRef.current) {
          setDeleteTarget(detailRef.current);
          setMode("confirm");
          return true;
        }
        if (key.name === "e" && detailRef.current) {
          setFormIntent("edit");
          setFormTarget(detailRef.current);
          editFormRef.current.open(memoryFields(detailRef.current));
          setMode("form");
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

  if (mode === "detail" && detail) {
    const fields = [
      { label: "ID", value: detail.id, color: colors.textDim },
      {
        label: "Importance",
        value: detail.importance,
        color: importanceColor[detail.importance] ?? colors.text,
      },
      { label: "Scope", value: detail.scope ?? "global" },
      { label: "Source", value: detail.source ?? "—" },
      { label: "Tags", value: detail.tags?.join(", ") ?? "—" },
      { label: "Expires", value: detail.expires_at ?? "never" },
      { label: "Created", value: detail.created_at },
      { label: "Updated", value: detail.updated_at },
    ];
    return (
      <DetailPane
        title={"Memory"}
        fields={fields}
        body={detail.content}
        renderMarkdown
        hint="Esc back • e edit • d delete • Up/Down scroll"
      />
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <ViewToolbar
        title="Memories"
        countLabel={loading ? "Loading memories…" : `${filtered.length} visible memories`}
        filterQuery={query}
        filterActive={filterActive}
        filterPlaceholder="Search content, scope, importance, or tags"
        onFilterChange={setQuery}
        onFilterSubmit={() => setFilterActive(false)}
        statusMessage={projectId ? "Project-scoped view" : "Global + project memories"}
      />
      <ResourceTable
        columns={columns}
        data={filtered}
        cursor={cursor}
        keyFn={(m) => m.id}
        loading={loading}
        error={error}
        emptyMessage="No memories stored yet."
        filteredEmptyMessage="No memories match the current search."
        hasActiveFilter={Boolean(query)}
        sort={sort}
        selectedSummary={
          filtered[cursor]
            ? `${filtered[cursor]?.importance} • ${(filtered[cursor]?.scope ?? "global").toString()}`
            : "Capture durable project knowledge with n."
        }
      />
      {mode === "form" && (
        <EditFormOverlay
          title={formIntent === "create" ? "New Memory" : "Edit Memory"}
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
        <ConfirmDialog message={`Delete memory "${deleteTarget.content.slice(0, 40)}…"?`} />
      )}
    </box>
  );
}
