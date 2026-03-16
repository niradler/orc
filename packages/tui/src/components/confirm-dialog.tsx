import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";

type Props = {
  message: string;
  active: boolean;
};

export function ConfirmDialog({ message, active }: Props) {
  const { width, height } = useTerminalDimensions();

  if (!active) return null;
  const boxWidth = Math.min(50, width - 4);

  return (
    <box
      position="absolute"
      top={Math.floor(height / 2) - 2}
      left={Math.floor((width - boxWidth) / 2)}
      width={boxWidth}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={colors.error}
      backgroundColor={colors.bg}
      padding={1}
      zIndex={100}
    >
      <text fg={colors.error} paddingBottom={1}>
        {"Confirm Delete"}
      </text>
      <text fg={colors.text} paddingBottom={1}>
        {message}
      </text>
      <box flexDirection="row" gap={2}>
        <text fg={colors.error}>{"y = delete"}</text>
        <text fg={colors.textDim}>{"n/Esc = cancel"}</text>
      </box>
    </box>
  );
}
