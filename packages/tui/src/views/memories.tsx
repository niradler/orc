import { useKeyboard } from "@opentui/react";
import { createOrcClient } from "@orc/sdk";
import type { Memory } from "@orc/sdk/types";
import { useCallback, useRef, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
import { ResourceTable } from "../components/resource-table.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors, importanceColor } from "../theme.js";
import type { Column, ViewMode } from "../types.js";

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

type Props = {
  projectId: string | null;
};

export function MemoriesView({ projectId }: Props) {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<Memory | null>(null);

  const { data, loading, refresh } = usePolling(
    () =>
      client.memories.list({
        ...(projectId ? { project_id: projectId } : {}),
        limit: 100,
      }),
    5000,
  );

  const memories = data?.memories ?? [];

  const {
    filtered,
    query,
    active: filterActive,
  } = useFilter(
    memories,
    (m) => `${m.content} ${m.scope ?? ""} ${m.importance} ${m.tags?.join(" ") ?? ""}`,
    mode === "list",
  );

  const { cursor } = useVimList(filtered.length, mode === "list" && !filterActive);

  const openDetail = useCallback(() => {
    const mem = filtered[cursor];
    if (!mem) return;
    setDetail(mem);
    setMode("detail");
  }, [filtered, cursor]);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const filterActiveRef = useRef(filterActive);
  filterActiveRef.current = filterActive;
  const openDetailRef = useRef(openDetail);
  openDetailRef.current = openDetail;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useKeyboard((key) => {
    if (modeRef.current === "list" && !filterActiveRef.current) {
      if (key.name === "return") openDetailRef.current();
      if (key.name === "r") refreshRef.current();
    }
    if (modeRef.current === "detail" && key.name === "escape") {
      setMode("list");
      setDetail(null);
    }
  });

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
    return <DetailPane title={"Memory"} fields={fields} body={detail.content} />;
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={2} marginBottom={0} paddingLeft={1}>
        <text fg={colors.text}>{"MEMORY"}</text>
        <text fg={colors.textDim}>{loading ? "loading…" : `${filtered.length} memories`}</text>
        {query && <text fg={colors.accent}>{`/${query}`}</text>}
      </box>
      <ResourceTable columns={columns} data={filtered} cursor={cursor} keyFn={(m) => m.id} />
    </box>
  );
}
