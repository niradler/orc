import { createOrcClient } from "@orc/sdk";
import type { Session } from "@orc/sdk/types";
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

const columns: Column<Session>[] = [
  {
    key: "agent",
    label: "Agent",
    width: 16,
    minWidth: 10,
    priority: 7,
    render: (s) => s.agent,
    color: () => colors.accent,
    sortValue: (s) => s.agent.toLowerCase(),
  },
  {
    key: "id",
    label: "ID",
    width: 10,
    minWidth: 8,
    priority: 4,
    render: (s) => s.id.slice(-8),
    color: () => colors.textDim,
  },
  {
    key: "summary",
    label: "Summary",
    width: 50,
    minWidth: 18,
    priority: 8,
    render: (s) => {
      const t = s.summary ?? "—";
      return t.length > 48 ? `${t.slice(0, 48)}…` : t;
    },
  },
  {
    key: "version",
    label: "Version",
    width: 12,
    minWidth: 8,
    priority: 3,
    render: (s) => s.agent_version ?? "—",
    color: () => colors.textDim,
  },
  {
    key: "tokens",
    label: "Tokens",
    width: 10,
    minWidth: 8,
    priority: 5,
    render: (s) => (s.tokens_used ? String(s.tokens_used) : "—"),
    color: () => colors.textDim,
    sortValue: (s) => s.tokens_used ?? 0,
  },
  {
    key: "created",
    label: "Created",
    width: 12,
    minWidth: 10,
    priority: 2,
    render: (s) => s.created_at.slice(0, 10),
    color: () => colors.textDim,
    sortValue: (s) => s.created_at,
  },
];

type Props = {
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
  onStateChange: (state: ViewState) => void;
  onRegisterCommands: (cmds: PaletteCommand[]) => void;
};

export function SessionsView({ onRegisterKeyHandler, onStateChange, onRegisterCommands }: Props) {
  const [mode, setMode] = useState<"browse" | "detail">("browse");
  const [detail, setDetail] = useState<
    (Session & { events: unknown[]; snapshot: string | null }) | null
  >(null);
  const { sort, cycleSort, setSortByKey, sortData } = useSort(columns, { key: "created", direction: "desc" });

  const { data, loading, error, refresh } = usePolling(
    () => client.sessions.list({ limit: 50 }),
    10000,
  );
  const sessions = data?.sessions ?? [];

  const {
    filtered: filteredUnsorted,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(sessions, (s) => `${s.agent} ${s.summary ?? ""} ${s.id}`, true);
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

  useEffect(() => {
    const selectedSession = filtered[cursor];
    const sortLabel = sort.key ? `${sort.key} ${sort.direction === "asc" ? "▲" : "▼"}` : null;
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Sessions",
      countLabel: loading ? "Loading sessions…" : `${filtered.length} sessions`,
      sortLabel,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode === "detail",
      selectionLabel: selectedSession
        ? `${selectedSession.agent} • ${selectedSession.id.slice(-8)}`
        : "No session selected yet.",
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
          const session = filteredRef.current[cursorRef.current];
          if (session) {
            client.sessions.get(session.id).then((result) => {
              if (result.data) {
                setDetail(result.data);
                setMode("detail");
              }
            });
          }
          return true;
        }
        if (isRefreshKey(key.name)) {
          refreshRef.current();
          return true;
        }
        if (key.name === "s") {
          cycleSort();
          return true;
        }
      }
      if (modeRef.current === "detail") {
        return handleDetailEscapeKey(key.name, () => {
          setMode("browse");
          setDetail(null);
        });
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
      { label: "ID", value: detail.id, color: colors.textDim },
      { label: "Agent", value: detail.agent, color: colors.accent },
      { label: "Version", value: detail.agent_version ?? "—" },
      { label: "Tokens", value: detail.tokens_used ? String(detail.tokens_used) : "—" },
      { label: "Events", value: String(detail.events?.length ?? 0) },
      { label: "Created", value: detail.created_at },
    ];
    return (
      <DetailPane
        title={`Session: ${detail.agent}`}
        fields={fields}
        body={detail.summary ?? detail.snapshot ?? undefined}
        hint="Esc back • Up/Down scroll"
      />
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <ViewToolbar
        title="Sessions"
        countLabel={loading ? "Loading sessions…" : `${filtered.length} visible sessions`}
        filterQuery={query}
        filterActive={filterActive}
        filterPlaceholder="Search by agent, summary, or session id"
        onFilterChange={setQuery}
        onFilterSubmit={() => setFilterActive(false)}
        statusMessage="Read-only audit surface"
      />
      <ResourceTable
        columns={columns}
        data={filtered}
        cursor={cursor}
        keyFn={(s) => s.id}
        loading={loading}
        error={error}
        emptyMessage="No sessions recorded yet."
        filteredEmptyMessage="No sessions match the current search."
        hasActiveFilter={Boolean(query)}
        sort={sort}
        selectedSummary={
          filtered[cursor]
            ? `${filtered[cursor]?.agent} • ${filtered[cursor]?.id.slice(-8)}`
            : "Agent sessions will appear here once they are logged."
        }
      />
    </box>
  );
}
