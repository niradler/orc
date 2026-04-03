import { type BoxRenderable, LayoutEvents } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useState } from "react";
import { colors } from "../theme.js";
import type { Column } from "../types.js";

type Props<T> = {
  columns: Column<T>[];
  data: T[];
  cursor: number;
  keyFn: (item: T) => string;
  loading: boolean;
  error?: string | null;
  emptyMessage: string;
  filteredEmptyMessage?: string;
  hasActiveFilter?: boolean;
  selectedSummary?: string | null;
};

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return value.slice(0, 1);
  return `${value.slice(0, width - 1)}…`;
}

export function ResourceTable<T>({
  columns,
  data,
  cursor,
  keyFn,
  loading,
  error,
  emptyMessage,
  filteredEmptyMessage,
  hasActiveFilter,
  selectedSummary,
}: Props<T>) {
  const { height } = useTerminalDimensions();
  const showEmpty = !loading && data.length === 0;
  const [visibleRows, setVisibleRows] = useState(Math.max(8, height - 18));
  const [bodyNode, setBodyNode] = useState<BoxRenderable | null>(null);

  const attachBodyRef = useCallback((node: BoxRenderable | null) => {
    setBodyNode(node);
  }, []);

  useEffect(() => {
    if (!bodyNode) return;

    const handleLayoutChange = () => {
      setVisibleRows(Math.max(1, bodyNode.height));
    };

    handleLayoutChange();
    bodyNode.on(LayoutEvents.LAYOUT_CHANGED, handleLayoutChange);
    return () => {
      bodyNode.off(LayoutEvents.LAYOUT_CHANGED, handleLayoutChange);
    };
  }, [bodyNode]);

  useEffect(() => {
    setVisibleRows(Math.max(8, height - 18));
  }, [height]);

  useEffect(() => {
    if (!bodyNode || loading || showEmpty) return;

    setVisibleRows(Math.max(1, bodyNode.height));
    const timeout = setTimeout(() => {
      setVisibleRows(Math.max(1, bodyNode.height));
    }, 0);

    return () => {
      clearTimeout(timeout);
    };
  }, [bodyNode, loading, showEmpty]);

  let startIdx = 0;
  if (cursor >= startIdx + visibleRows) {
    startIdx = cursor - visibleRows + 1;
  }
  if (cursor < startIdx) {
    startIdx = cursor;
  }

  const visible = data.slice(startIdx, startIdx + visibleRows);

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={colors.border}
      backgroundColor={colors.bgElevated}
      padding={1}
    >
      <box flexDirection="row" gap={0} paddingLeft={1} paddingRight={1}>
        {columns.map((col) => (
          <text key={col.key} fg={colors.textDim} width={col.width}>
            {truncate(col.label.toUpperCase(), col.width)}
          </text>
        ))}
      </box>

      <box height={1} marginTop={1} marginBottom={1}>
        <text fg={colors.border}>{"─".repeat(120)}</text>
      </box>

      {loading ? (
        <box
          flexGrow={1}
          justifyContent="center"
          alignItems="center"
          backgroundColor={colors.bg}
          border
          borderStyle="single"
          borderColor={colors.border}
        >
          <text fg={colors.textDim}>{"Loading ORC data…"}</text>
        </box>
      ) : showEmpty ? (
        <box
          flexGrow={1}
          justifyContent="center"
          alignItems="center"
          backgroundColor={colors.bg}
          border
          borderStyle="single"
          borderColor={colors.border}
        >
          <text fg={colors.textDim}>
            {hasActiveFilter ? (filteredEmptyMessage ?? emptyMessage) : emptyMessage}
          </text>
        </box>
      ) : (
        <box
          ref={attachBodyRef}
          flexDirection="column"
          flexGrow={1}
          onSizeChange={function (this: BoxRenderable) {
            setVisibleRows(Math.max(1, this.height));
          }}
        >
          {visible.map((item, vi) => {
            const realIdx = startIdx + vi;
            const selected = realIdx === cursor;
            return (
              <box
                key={keyFn(item)}
                flexDirection="row"
                gap={0}
                backgroundColor={selected ? colors.bgSelected : colors.bgElevated}
                paddingLeft={1}
                paddingRight={1}
              >
                {columns.map((col) => (
                  <text
                    key={col.key}
                    fg={selected ? colors.text : col.color ? col.color(item) : colors.text}
                    width={col.width}
                  >
                    {truncate(col.render(item), col.width)}
                  </text>
                ))}
              </box>
            );
          })}
        </box>
      )}

      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        marginTop={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={error ? colors.warning : colors.textMuted}>
          {error
            ? `Data warning: ${truncate(error, 72)}`
            : (selectedSummary ?? "Use arrows or j/k to move through the list.")}
        </text>
        <text fg={colors.textMuted}>
          {data.length > 0 ? `${Math.min(cursor + 1, data.length)} / ${data.length}` : "0 / 0"}
        </text>
      </box>
    </box>
  );
}
