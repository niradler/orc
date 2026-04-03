import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";

type Props = {
  message: string;
  active: boolean;
};

export function ConfirmDialog({ message, active }: Props) {
  const { width } = useTerminalDimensions();

  if (!active) return null;
  const boxWidth = Math.min(50, width - 4);

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
        <box flexDirection="row" gap={2}>
          <text fg={colors.error}>{"Enter / y = delete"}</text>
          <text fg={colors.textDim}>{"Esc / n = cancel"}</text>
        </box>
      </box>
    </box>
  );
}
