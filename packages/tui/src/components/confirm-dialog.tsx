import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";
import { getScreenSize } from "../types.js";

type Props = {
  message: string;
};

export function ConfirmDialog({ message }: Props) {
  const { width } = useTerminalDimensions();
  const screen = getScreenSize(width);
  const boxWidth = screen === "xs" ? Math.max(24, width - 2) : Math.min(54, width - 4);

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      backgroundColor={colors.bg}
      paddingLeft={1}
      paddingRight={1}
      zIndex={100}
    >
      <box
        width={boxWidth}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={colors.error}
        backgroundColor={colors.bgElevated}
        padding={2}
      >
        <text fg={colors.error} paddingBottom={1}>
          {"Confirm Delete"}
        </text>
        <text fg={colors.text} paddingBottom={1}>
          {message}
        </text>
        <box flexDirection={screen === "xs" ? "column" : "row"} gap={1}>
          <text fg={colors.error}>{"Enter / y = delete"}</text>
          <text fg={colors.textDim}>{"Esc / n = cancel"}</text>
        </box>
      </box>
    </box>
  );
}
