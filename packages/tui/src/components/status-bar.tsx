import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";
import type { ViewMode } from "../types.js";

type Props = {
  mode: ViewMode;
  filterQuery: string;
  filterActive: boolean;
};

const HINTS: Record<ViewMode, string> = {
  list: "j/k nav  ←→ tabs  Enter view  e edit  n new  d del  / filter  :cmd  Ctrl+C quit",
  detail: "Esc back  e edit  d delete  :cmd  Ctrl+C quit",
  edit: "j/k fields  Enter edit  w save  Esc cancel",
  create: "j/k fields  Enter edit  w save  Esc cancel",
  confirm: "y confirm  n/Esc cancel",
};

export function StatusBar({ mode, filterQuery, filterActive }: Props) {
  const { width } = useTerminalDimensions();

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
        <text fg={colors.textMuted}>{HINTS[mode] ?? ""}</text>
      </box>
      <box paddingRight={1}>
        <text fg={colors.accentAlt}>{mode !== "list" ? `[${mode}]` : ""}</text>
      </box>
    </box>
  );
}
