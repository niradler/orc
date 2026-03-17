import { createOrcClient } from "@orc/sdk";
import type { Session } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
import { ResourceTable } from "../components/resource-table.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors } from "../theme.js";
import type { Column, KeyEvent, ViewKeyHandler, ViewMode } from "../types.js";

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
  onStateChange: (mode: ViewMode, filterQuery: string, filterActive: boolean) => void;
};

export function SessionsView({ onRegisterKeyHandler, onStateChange }: Props) {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<
    (Session & { events: unknown[]; snapshot: string | null }) | null
  >(null);

  const { data, loading, refresh } = usePolling(() => client.sessions.list({ limit: 50 }), 10000);
  const sessions = data?.sessions ?? [];

  const {
    filtered,
    query,
    active: filterActive,
    handleKey: filterHandleKey,
  } = useFilter(sessions, (s) => `${s.agent} ${s.summary ?? ""} ${s.id}`, mode === "list");
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

  useEffect(() => {
    onStateChange(mode, query, filterActive);
  }, [mode, query, filterActive, onStateChange]);

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (filterHandleKey(key)) return true;
      if (modeRef.current === "list" && !filterActiveRef.current) {
        if (vimHandleKey(key)) return true;
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
        setMode("list");
        setDetail(null);
        return true;
      }
      return false;
    },
    [filterHandleKey, vimHandleKey],
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
      />
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={2} marginBottom={0} paddingLeft={1}>
        <text fg={colors.text}>{"SESSIONS"}</text>
        <text fg={colors.textDim}>{loading ? "loading…" : `${filtered.length} sessions`}</text>
        {query && <text fg={colors.accent}>{`/${query}`}</text>}
      </box>
      <ResourceTable columns={columns} data={filtered} cursor={cursor} keyFn={(s) => s.id} />
    </box>
  );
}
