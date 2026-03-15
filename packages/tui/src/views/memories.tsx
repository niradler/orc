import { createOrcClient } from "@orc/sdk";
import type { Memory } from "@orc/sdk/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { DetailPane } from "../components/detail-pane.js";
import { ResourceTable } from "../components/resource-table.js";
import { useFilter } from "../hooks/use-filter.js";
import { usePolling } from "../hooks/use-polling.js";
import { useVimList } from "../hooks/use-vim-list.js";
import { colors, importanceColor } from "../theme.js";
import type { Column, KeyEvent, ViewKeyHandler, ViewMode } from "../types.js";

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

type Props = { projectId: string | null; onRegisterKeyHandler: (handler: ViewKeyHandler) => void };

export function MemoriesView({ projectId, onRegisterKeyHandler }: Props) {
  const [mode, setMode] = useState<ViewMode>("list");
  const [detail, setDetail] = useState<Memory | null>(null);

  const { data, loading, refresh } = usePolling(
    () => client.memories.list({ ...(projectId ? { project_id: projectId } : {}), limit: 100 }),
    5000,
  );
  const memories = data?.memories ?? [];

  const {
    filtered,
    query,
    active: filterActive,
    handleKey: filterHandleKey,
  } = useFilter(
    memories,
    (m) => `${m.content} ${m.scope ?? ""} ${m.importance} ${m.tags?.join(" ") ?? ""}`,
    mode === "list",
  );
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

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (filterHandleKey(key)) return true;
      if (modeRef.current === "list" && !filterActiveRef.current) {
        if (vimHandleKey(key)) return true;
        if (key.name === "return") {
          const mem = filteredRef.current[cursorRef.current];
          if (mem) {
            setDetail(mem);
            setMode("detail");
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
