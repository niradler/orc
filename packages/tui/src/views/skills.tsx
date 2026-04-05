import { createOrcClient } from "@orc/sdk";
import type { SkillMeta } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
import { ResourceTable } from "../components/resource-table.js";
import { ViewToolbar } from "../components/view-toolbar.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import {
  handleDetailEscapeKey,
  handleFilterInputKey,
  isFilterToggleKey,
  isOpenDetailKey,
  isRefreshKey,
} from "../navigation.js";
import { colors } from "../theme.js";
import type { Column, KeyEvent, ViewKeyHandler, ViewState } from "../types.js";

const client = createOrcClient();

const columns: Column<SkillMeta>[] = [
  {
    key: "source",
    label: "Src",
    width: 5,
    minWidth: 4,
    priority: 6,
    render: (s) => (s.source === "user" ? "user" : "built"),
    color: (s) => (s.source === "user" ? colors.warning : colors.textDim),
  },
  { key: "name", label: "Name", width: 24, minWidth: 14, priority: 7, render: (s) => s.name },
  {
    key: "desc",
    label: "Description",
    width: 40,
    minWidth: 16,
    priority: 5,
    render: (s) => {
      const t = s.description || "—";
      return t.length > 38 ? `${t.slice(0, 38)}…` : t;
    },
    color: () => colors.textDim,
  },
];

type Props = {
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
  onStateChange: (state: ViewState) => void;
};

export function SkillsView({ onRegisterKeyHandler, onStateChange }: Props) {
  const [mode, setMode] = useState<"browse" | "detail">("browse");
  const [detail, setDetail] = useState<{ meta: SkillMeta; content: string } | null>(null);

  const { data, loading, error, refresh } = usePolling(() => client.skills.list(), 30000);
  const skills = data?.skills ?? [];
  const {
    filtered,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(skills, (s) => `${s.name} ${s.description}`, true);
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

  useEffect(() => {
    const selected = filtered[cursor];
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Skills",
      countLabel: loading ? "Loading skills…" : `${filtered.length} skills`,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode !== "browse",
      selectionLabel:
        mode === "detail" && detail
          ? `Skill detail • ${detail.meta.name}`
          : selected
            ? `${selected.name} • ${selected.source}`
            : "No skill selected.",
      detailId: mode === "detail" ? (detail?.meta.name ?? null) : null,
      statusMessage: mode === "detail" ? "Esc to go back" : "Enter opens detail",
    });
  }, [mode, query, filterActive, onStateChange, filtered, cursor, detail, loading]);

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (filterActiveRef.current) {
        return handleFilterInputKey(key.name, setFilterActive);
      }
      if (modeRef.current === "browse" && !filterActiveRef.current) {
        if (vimHandleKey(key)) return true;
        if (isFilterToggleKey(key.name)) {
          setFilterActive(true);
          return true;
        }
        if (isOpenDetailKey(key.name)) {
          const s = filteredRef.current[cursorRef.current];
          if (s)
            client.skills.read(s.name).then((r) => {
              if (r.data && "content" in r.data) {
                setDetail({ meta: s, content: r.data.content });
                setMode("detail");
              }
            });
          return true;
        }
        if (isRefreshKey(key.name)) {
          refreshRef.current();
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
      { label: "Name", value: detail.meta.name },
      { label: "Source", value: detail.meta.source },
      { label: "Path", value: detail.meta.path, color: colors.textDim },
    ];
    return (
      <DetailPane
        title={`Skill: ${detail.meta.name}`}
        fields={fields}
        body={detail.content}
        renderMarkdown
        hint="Esc back • Up/Down scroll"
      />
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <ViewToolbar
        title="Skills"
        countLabel={loading ? "Loading skills…" : `${filtered.length} skills`}
        filterQuery={query}
        filterActive={filterActive}
        filterPlaceholder="Search by name or description"
        onFilterChange={setQuery}
        onFilterSubmit={() => setFilterActive(false)}
        statusMessage="Built-in and user skills from ~/.orc/skills"
      />
      <ResourceTable
        columns={columns}
        data={filtered}
        cursor={cursor}
        keyFn={(s) => s.name}
        loading={loading}
        error={error}
        emptyMessage="No skills installed."
        filteredEmptyMessage="No skills match the current search."
        hasActiveFilter={Boolean(query)}
        selectedSummary={
          filtered[cursor]
            ? `${filtered[cursor]?.name} • ${filtered[cursor]?.source}`
            : "No skills installed yet."
        }
      />
    </box>
  );
}
