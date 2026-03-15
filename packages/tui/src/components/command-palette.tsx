import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";
import type { Command } from "../types.js";

type Props = {
  active: boolean;
  input: string;
  commands: Command[];
};

export function CommandPalette({ active, input, commands }: Props) {
  const { width, height } = useTerminalDimensions();

  if (!active) return null;

  const lower = input.toLowerCase();
  const matches = input
    ? commands.filter((c) => c.name.startsWith(lower) || c.aliases.some((a) => a.startsWith(lower)))
    : commands;

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
      borderColor={colors.accent}
      backgroundColor={colors.bg}
      padding={1}
      zIndex={100}
    >
      <box flexDirection="row" gap={0} marginBottom={1}>
        <text fg={colors.accent}>{":"}</text>
        <text fg={colors.text}>{input}</text>
        <text fg={colors.accent}>{"█"}</text>
      </box>
      {matches.slice(0, 8).map((cmd) => (
        <box key={cmd.name} flexDirection="row" gap={2} paddingLeft={1}>
          <text fg={colors.accent} width={12}>
            {cmd.name}
          </text>
          <text fg={colors.textDim}>{cmd.description}</text>
        </box>
      ))}
      {matches.length === 0 && (
        <text fg={colors.textDim} paddingLeft={1}>
          {"no matching command"}
        </text>
      )}
    </box>
  );
}
