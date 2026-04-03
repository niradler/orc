import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";

type Props = {
  title: string;
  countLabel: string;
  filterQuery: string;
  filterActive: boolean;
  filterPlaceholder?: string;
  onFilterChange: (value: string) => void;
  onFilterSubmit: () => void;
  statusMessage?: string | null;
};

export function ViewToolbar({
  title,
  countLabel,
  filterQuery,
  filterActive,
  filterPlaceholder,
  onFilterChange,
  onFilterSubmit,
  statusMessage,
}: Props) {
  const { width } = useTerminalDimensions();
  const compact = width < 86;
  const searchWidth = compact ? Math.max(18, width - 18) : 32;

  return (
    <box
      flexDirection={compact ? "column" : "row"}
      justifyContent="space-between"
      alignItems={compact ? "stretch" : "center"}
      gap={2}
      marginBottom={1}
    >
      <box flexDirection="column">
        <text fg={colors.text}>
          <strong>{title}</strong>
        </text>
        <text fg={colors.textDim}>{countLabel}</text>
      </box>

      <box
        flexDirection="row"
        gap={1}
        alignItems="center"
        backgroundColor={filterActive ? colors.bgSelected : colors.bgLight}
        border
        borderStyle="single"
        borderColor={filterActive ? colors.borderFocus : colors.border}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={filterActive || filterQuery ? colors.accent : colors.textDim}>{"Search"}</text>
        <input
          focused={filterActive}
          value={filterQuery}
          placeholder={filterPlaceholder ?? "Type / to filter"}
          width={searchWidth}
          backgroundColor={filterActive ? colors.bgSelected : colors.bgLight}
          focusedBackgroundColor={colors.bgSelected}
          textColor={colors.text}
          cursorColor={colors.accent}
          placeholderColor={colors.textMuted}
          onChange={onFilterChange}
          onSubmit={onFilterSubmit}
        />
      </box>

      {statusMessage ? <text fg={colors.textMuted}>{statusMessage}</text> : <box width={1} />}
    </box>
  );
}
