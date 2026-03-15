import { useTerminalDimensions } from "@opentui/react";
import type { Column } from "../types.js";
import { colors } from "../theme.js";

type Props<T> = {
  columns: Column<T>[];
  data: T[];
  cursor: number;
  keyFn: (item: T) => string;
};

export function ResourceTable<T>({
  columns,
  data,
  cursor,
  keyFn,
}: Props<T>) {
  const { height } = useTerminalDimensions();
  const visibleRows = height - 5;

  let startIdx = 0;
  if (cursor >= startIdx + visibleRows) {
    startIdx = cursor - visibleRows + 1;
  }
  if (cursor < startIdx) {
    startIdx = cursor;
  }

  const visible = data.slice(startIdx, startIdx + visibleRows);

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={0} marginBottom={0}>
        {columns.map((col) => (
          <text
            key={col.key}
            fg={colors.textDim}
            width={col.width}
            paddingLeft={1}
          >
            {col.label.toUpperCase()}
          </text>
        ))}
      </box>
      <box
        height={1}
        flexDirection="row"
        backgroundColor={colors.bgLight}
      >
        <text fg={colors.border}>
          {"─".repeat(100)}
        </text>
      </box>
      {visible.map((item, vi) => {
        const realIdx = startIdx + vi;
        const selected = realIdx === cursor;
        return (
          <box
            key={keyFn(item)}
            flexDirection="row"
            gap={0}
            backgroundColor={selected ? colors.bgHighlight : undefined}
          >
            {columns.map((col) => (
              <text
                key={col.key}
                fg={
                  selected
                    ? colors.accent
                    : col.color
                      ? col.color(item)
                      : colors.text
                }
                width={col.width}
                paddingLeft={1}
              >
                {col.render(item)}
              </text>
            ))}
          </box>
        );
      })}
    </box>
  );
}
