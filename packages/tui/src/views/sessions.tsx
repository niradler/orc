import { createOrcClient } from "@orc/sdk";
import type { Session } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
import { ResourceTable } from "../components/resource-table.js";
import { ViewToolbar } from "../components/view-toolbar.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors } from "../theme.js";
import type { Column, KeyEvent, ViewKeyHandler, ViewState } from "../types.js";

const client = createOrcClient();

const columns: Column<Session>[] = [
  { key: "agent", label: "Agent", width: 16, render: (s) => s.agent, color: () => colors.accent },
  { key: "id", label: "ID", width: 10, render: (s) => s.id.slice(-8), color: () => colors.textDim },
  {
    key: "summary",
    label: "Summary",
    width: 50,
    render: (s) => {
      const t = s.summary ?? "—";
      return t.length > 48 ? `${t.slice(0, 48)}…` : t;
    },
  },
  {
    key: "tokens",
    label: "Tokens",
    width: 10,
    render: (s) => (s.tokens_used ? String(s.tokens_used) : "—"),
    color: () => colors.textDim,
  },
  {
    key: "created",
    label: "Created",
    width: 20,
    render: (s) => s.created_at,
    color: () => colors.textDim,
  },
];

type Props = {
  onRegisterKeyHandler: (handler: ViewKeyHandler) => void;
  onStateChange: (state: ViewState) => void;
};

export function SessionsView({ onRegisterKeyHandler, onStateChange }: Props) {
  const [mode, setMode] = useState<"browse" | "detail">("browse");
  const [detail, setDetail] = useState<
    (Session & { events: unknown[]; snapshot: string | null }) | null
  >(null);

  const { data, loading, error, refresh } = usePolling(
    () => client.sessions.list({ limit: 50 }),
    10000,
  );
  const sessions = data?.sessions ?? [];

  const {
    filtered,
    query,
    active: filterActive,
    setQuery,
    setActive: setFilterActive,
  } = useFilter(sessions, (s) => `${s.agent} ${s.summary ?? ""} ${s.id}`, true);
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
    onStateChange({
      mode: filterActive ? "filter" : mode,
      title: "Sessions",
      countLabel: loading ? "Loading sessions…" : `${filtered.length} visible sessions`,
      filterQuery: query,
      filterActive,
      navigationLocked: filterActive || mode === "detail",
      selectionLabel:
        mode === "detail" && detail
          ? `Session detail • ${detail.agent}`
          : selectedSession
            ? `${selectedSession.agent} • ${selectedSession.id.slice(-8)}`
            : "No session selected yet.",
      detailId: mode === "detail" ? (detail?.id ?? null) : null,
      statusMessage: mode === "detail" ? "Read-only detail • Esc back" : "Read-only audit surface",
    });
  }, [mode, query, filterActive, onStateChange, filtered, cursor, detail, loading]);

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (filterActiveRef.current) {
        if (key.name === "escape" || key.name === "return") {
          setFilterActive(false);
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
        if (key.name === "r") {
          refreshRef.current();
          return true;
        }
      }
      if (modeRef.current === "detail" && key.name === "escape") {
        setMode("browse");
        setDetail(null);
        return true;
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
        selectedSummary={
          filtered[cursor]
            ? `${filtered[cursor]?.agent} • ${filtered[cursor]?.id.slice(-8)}`
            : "Agent sessions will appear here once they are logged."
        }
      />
    </box>
  );
}
