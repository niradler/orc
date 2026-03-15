import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";
import type { ViewMode } from "../types.js";

type Props = {
  mode: ViewMode;
  filterQuery: string;
  filterActive: boolean;
  itemCount: number;
  filteredCount: number;
};

const LIST_HINTS = "j/k nav  Enter detail  / filter  : command  q quit";
const DETAIL_HINTS = "Esc back  j/k scroll  : command  q quit";

export function StatusBar({ mode, filterQuery, filterActive, itemCount, filteredCount }: Props) {
  const { width } = useTerminalDimensions();
  const hints = mode === "list" ? LIST_HINTS : DETAIL_HINTS;

  return (
    <box
      flexDirection="row"
      width={width}
      height={1}
      backgroundColor={colors.bgLight}
      justifyContent="space-between"
    >
      <box flexDirection="row" gap={1} paddingLeft={1}>
        {filterActive ? (
          <text fg={colors.accent}>{`/${filterQuery}█`}</text>
        ) : filterQuery ? (
          <text fg={colors.textDim}>{`/${filterQuery}`}</text>
        ) : null}
        <text fg={colors.textMuted}>{hints}</text>
      </box>
      <box paddingRight={1}>
        <text fg={colors.textDim}>
          {filterQuery ? `${filteredCount}/${itemCount}` : `${itemCount} items`}
        </text>
      </box>
    </box>
  );
}
