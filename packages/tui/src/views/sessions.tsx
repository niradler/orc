import { useKeyboard } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import type { Session } from "@orc/sdk/types";
import { useCallback, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
import { ResourceTable } from "../components/resource-table.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors } from "../theme.js";
import type { Column, ViewMode } from "../types.js";

const client = createOrcClient();

const columns: Column<Session>[] = [
  {
    key: "agent",
    label: "Agent",
    width: 16,
    render: (s) => s.agent,
    color: () => colors.accent,
  },
  {
    key: "id",
    label: "ID",
    width: 10,
    render: (s) => s.id.slice(-8),
    color: () => colors.textDim,
  },
  {
    key: "summary",
    label: "Summary",
    width: 50,
    render: (s) => {
      const text = s.summary ?? "—";
      return text.length > 48 ? `${text.slice(0, 48)}…` : text;
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

export function SessionsView() {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<(Session & { events: unknown[]; snapshot: string | null }) | null>(null);

  const { data, loading, refresh } = usePolling(
    () => client.sessions.list({ limit: 50 }),
    10000,
  );

  const sessions = data?.sessions ?? [];

  const { filtered, query, active: filterActive } = useFilter(
    sessions,
    (s) => `${s.agent} ${s.summary ?? ""} ${s.id}`,
    mode === "list",
  );

  const { cursor } = useVimList(filtered.length, mode === "list" && !filterActive);

  const openDetail = useCallback(async () => {
    const session = filtered[cursor];
    if (!session) return;
    const result = await client.sessions.get(session.id);
    if (result.data) {
      setDetail(result.data);
      setMode("detail");
    }
  }, [filtered, cursor]);

  useKeyboard((key) => {
    if (mode === "list" && !filterActive) {
      if (key.name === "return") openDetail();
      if (key.name === "r") refresh();
    }
    if (mode === "detail" && key.name === "escape") {
      setMode("list");
      setDetail(null);
    }
  });

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
        <text fg={colors.textDim}>
          {loading ? "loading…" : `${filtered.length} sessions`}
        </text>
        {query && <text fg={colors.accent}>{`/${query}`}</text>}
      </box>
      <ResourceTable
        columns={columns}
        data={filtered}
        cursor={cursor}
        keyFn={(s) => s.id}
      />
    </box>
  );
}
