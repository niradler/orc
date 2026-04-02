import { createOrcClient } from "@orc/sdk";
import type { Memory } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { DetailPane } from "../components/detail-pane.js";
import { EditFormOverlay, type FormField, useEditForm } from "../components/edit-form.js";
import { ResourceTable } from "../components/resource-table.js";
import { ViewToolbar } from "../components/view-toolbar.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors, importanceColor } from "../theme.js";
import type { Column, KeyEvent, SelectOption, ViewKeyHandler, ViewState } from "../types.js";

const client = createOrcClient();

const columns: Column<Memory>[] = [
  {
    key: "importance",
    label: "Imp",
    width: 10,
    render: (m) => m.importance,
    color: (m) => importanceColor[m.importance] ?? colors.text,
  },
  {
    key: "scope",
    label: "Scope",
    width: 14,
    render: (m) => m.scope ?? "global",
    color: () => colors.textDim,
  },
  {
    key: "content",
    label: "Content",
    width: 60,
    render: (m) => (m.content.length > 58 ? `${m.content.slice(0, 58)}…` : m.content),
  },
  {
    key: "created",
    label: "Created",
    width: 12,
    render: (m) => m.created_at.slice(0, 10),
    color: () => colors.textDim,
  },
];

function memoryFields(): FormField[] {
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
  return [
    {
      key: "content",
      label: "Content",
      value: "",
      type: "textarea",
      height: 8,
      placeholder: "Store a fact, decision, rule, or discovery",
    },
    {
      key: "type",
      label: "Type",
      value: "fact",
      type: "select",
      options: typeOptions,
    },
    {
      key: "importance",
      label: "Importance",
      value: "normal",
      type: "select",
      options: importanceOptions,
    },
    { key: "scope", label: "Scope", value: "", placeholder: "global or subsystem" },
    { key: "tags", label: "Tags", value: "", placeholder: "search, api, rule" },
  ];
}

type Props = {
  projectId: string | null;
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
  onStateChange: (state: ViewState) => void;
};

export function MemoriesView({ projectId, onRegisterKeyHandler, onStateChange }: Props) {
  const [mode, setMode] = useState<"browse" | "detail" | "form" | "confirm">("browse");
  const [detail, setDetail] = useState<Memory | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null);
  const editForm = useEditForm();

  const { data, loading, error, refresh } = usePolling(
    () => client.memories.list({ ...(projectId ? { project_id: projectId } : {}), limit: 100 }),
    5000,
  );
  const memories = data?.memories ?? [];
  const {
    filtered,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(
    memories,
    (m) => `${m.content} ${m.scope ?? ""} ${m.importance} ${m.tags?.join(" ") ?? ""}`,
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

  useEffect(() => {
    const selectedMemory = filtered[cursor];
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Memories",
      countLabel: loading ? "Loading memories…" : `${filtered.length} visible memories`,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode === "form" || mode === "confirm",
      selectionLabel:
        mode === "detail" && detail
          ? `Memory detail • ${detail.importance}`
          : selectedMemory
            ? `${selectedMemory.importance} • ${(selectedMemory.scope ?? "global").toString()}`
            : "No memory selected yet.",
      detailId: mode === "detail" ? (detail?.id ?? null) : null,
      statusMessage: "Memories update live as the API polls.",
    });
  }, [mode, query, filterActive, onStateChange, filtered, cursor, detail, loading]);

  const doCreate = useCallback(
    (vals: Record<string, string>) => {
      if (!vals.content) return;
      const tags = vals.tags
        ? vals.tags
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      client.memories
        .create({
          content: vals.content,
          type: (vals.type as "fact" | "decision" | "event" | "rule" | "discovery") || "fact",
          importance: (vals.importance as "low" | "normal" | "high" | "critical") || "normal",
          ...(vals.scope ? { scope: vals.scope } : {}),
          ...(tags ? { tags } : {}),
          ...(projectId ? { project_id: projectId } : {}),
        })
        .then(() => refreshRef.current());
    },
    [projectId],
  );

  const doCreateRef = useRef(doCreate);
  doCreateRef.current = doCreate;

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
          return true;
        }
        if (key.ctrl && key.name === "s") {
          const result = editFormRef.current.submit();
          doCreateRef.current(result.values);
          setMode("browse");
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
        if (key.name === "/" || key.name === "f") {
          setFilterActive(true);
          return true;
        }
        if (key.name === "return") {
          const m = filteredRef.current[cursorRef.current];
          if (m) {
            setDetail(m);
            setMode("detail");
          }
          return true;
        }
        if (key.name === "r") {
          refreshRef.current();
          return true;
        }
        if (key.name === "n") {
          editFormRef.current.open(memoryFields());
          setMode("form");
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
        if (key.name === "escape") {
          setMode("browse");
          setDetail(null);
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
    [vimHandleKey, setFilterActive],
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
    return <DetailPane title={"Memory"} fields={fields} body={detail.content} renderMarkdown />;
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
        selectedSummary={
          filtered[cursor]
            ? `${filtered[cursor]?.importance} • ${(filtered[cursor]?.scope ?? "global").toString()}`
            : "Capture durable project knowledge with n."
        }
      />
      <EditFormOverlay
        title="New Memory"
        fields={editForm.fields}
        focusIdx={editForm.focusIdx}
        active={mode === "form"}
        onChange={editForm.updateValue}
      />
      <ConfirmDialog
        message={deleteTarget ? `Delete memory "${deleteTarget.content.slice(0, 40)}…"?` : ""}
        active={mode === "confirm"}
      />
    </box>
  );
}
