import { createOrcClient } from "@orc/sdk";
import type { SkillMeta } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
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
import { colors } from "../theme.js";
import type { Column, KeyEvent, PaletteCommand, ViewKeyHandler, ViewState } from "../types.js";

const client = createOrcClient();

const columns: Column<SkillMeta>[] = [
  {
    key: "source",
    label: "Source",
    width: 8,
    minWidth: 5,
    priority: 6,
    render: (s) => (s.source === "user" ? "user" : "builtin"),
    color: (s) => (s.source === "user" ? colors.warning : colors.textDim),
    sortValue: (s) => s.source,
  },
  {
    key: "name",
    label: "Name",
    width: 24,
    minWidth: 14,
    priority: 8,
    render: (s) => s.name,
    sortValue: (s) => s.name.toLowerCase(),
  },
  {
    key: "desc",
    label: "Description",
    width: 40,
    minWidth: 16,
    priority: 7,
    render: (s) => {
      const t = s.description || "—";
      return t.length > 38 ? `${t.slice(0, 38)}…` : t;
    },
    color: () => colors.textDim,
  },
  {
    key: "path",
    label: "Path",
    width: 30,
    minWidth: 14,
    priority: 1,
    render: (s) => s.path,
    color: () => colors.textDim,
  },
];

type Props = {
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
  onStateChange: (state: ViewState) => void;
  onRegisterCommands: (cmds: PaletteCommand[]) => void;
};

export function SkillsView({ onRegisterKeyHandler, onStateChange, onRegisterCommands }: Props) {
  const [mode, setMode] = useState<"browse" | "detail">("browse");
  const [detail, setDetail] = useState<{ meta: SkillMeta; content: string } | null>(null);
  const { sort, cycleSort, setSortByKey, sortData } = useSort(columns, { key: "name", direction: "asc" });

  const [reloading, setReloading] = useState(false);
  const { data, loading, error, refresh } = usePolling(() => client.skills.list(), 30000);

  const reloadSkills = useCallback(async () => {
    setReloading(true);
    await client.skills.list({ reload: true });
    refresh();
    setReloading(false);
  }, [refresh]);
  const skills = data?.skills ?? [];
  const {
    filtered: filteredUnsorted,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(skills, (s) => `${s.name} ${s.description}`, true);
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
  const reloadRef = useRef(reloadSkills);
  reloadRef.current = reloadSkills;

  useEffect(() => {
    const selected = filtered[cursor];
    const sortLabel = sort.key ? `${sort.key} ${sort.direction === "asc" ? "▲" : "▼"}` : null;
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Skills",
      countLabel: reloading
        ? "Reloading skills cache…"
        : loading
          ? "Loading skills…"
          : `${filtered.length} skills`,
      sortLabel,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode !== "browse",
      selectionLabel: selected
        ? `${selected.name} • ${selected.source}`
        : "No skill selected.",
      detailId: mode === "detail" ? (detail?.meta.name ?? null) : null,
      statusMessage: null,
      contextData:
        mode === "detail" && detail
          ? JSON.stringify(detail, null, 2)
          : filtered[cursor]
            ? JSON.stringify(filtered[cursor], null, 2)
            : null,
    });
  }, [mode, query, filterActive, onStateChange, filtered, cursor, detail, loading, sort, reloading]);

  useEffect(() => {
    const sortCommands: PaletteCommand[] = columns
      .filter((c) => c.sortValue)
      .map((col) => ({
        id: `sort-${col.key}`,
        name: `Sort by ${col.label}`,
        category: "sort" as const,
        aliases: [`sort ${col.key}`, `sort ${col.label.toLowerCase()}`],
        icon: "↕",
        ...(sort.key === col.key ? { hint: `${sort.direction === "asc" ? "▲" : "▼"} current` } : {}),
        available: () => modeRef.current === "browse",
        execute: () => setSortByKey(col.key),
      }));
    onRegisterCommands(sortCommands);
  }, [onRegisterCommands, setSortByKey, sort]);

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
        if (key.name === "R" || (key.name === "r" && key.shift)) {
          void reloadRef.current();
          return true;
        }
        if (key.name === "s") {
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
        return false;
      }
      return false;
    },
    [vimHandleKey, setFilterActive, cycleSort],
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
        sort={sort}
        selectedSummary={
          filtered[cursor]
            ? `${filtered[cursor]?.name} • ${filtered[cursor]?.source}`
            : "No skills installed yet."
        }
      />
    </box>
  );
}
