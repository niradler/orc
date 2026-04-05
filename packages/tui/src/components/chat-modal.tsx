import { useTerminalDimensions } from "@opentui/react";
import type { ChatMessage } from "../hooks/use-chat.js";
import { colors } from "../theme.js";
import { getScreenSize } from "../types.js";

type Props = {
  messages: ChatMessage[];
  streaming: boolean;
  streamText: string;
  agent: string;
  onSend: (text: string) => void;
  onCancel: () => void;
  onClose: () => void;
  onClear: () => void;
  inputValue: string;
  onInputChange: (value: string) => void;
};

export function ChatModal({
  messages,
  streaming,
  streamText,
  agent,
  onSend,
  onCancel,
  onClose,
  onClear,
  inputValue,
  onInputChange,
}: Props) {
  const { width, height } = useTerminalDimensions();
  const screen = getScreenSize(width);
  const compact = screen === "xs";

  const boxWidth = compact ? width : Math.min(width - 2, 120);
  const boxHeight = height - (compact ? 0 : 2);

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
      zIndex={100}
    >
      <box
        width={boxWidth}
        height={boxHeight}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={colors.borderFocus}
        backgroundColor={colors.bgElevated}
        title={` Chat · ${agent} `}
        titleAlignment="left"
      >
        <box
          flexDirection="row"
          justifyContent="space-between"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={0}
          paddingBottom={0}
        >
          <text fg={colors.textMuted}>
            {streaming ? "Streaming… Ctrl+C cancel" : "Enter send · Esc close · Ctrl+L clear"}
          </text>
          <text fg={streaming ? colors.warning : colors.success}>
            {streaming ? "● streaming" : "● ready"}
          </text>
        </box>

        <box height={1}>
          <text fg={colors.border}>{"─".repeat(Math.max(4, boxWidth - 4))}</text>
        </box>

        <scrollbox
          flexGrow={1}
          minHeight={0}
          viewportOptions={{ backgroundColor: colors.bgElevated }}
          contentOptions={{ backgroundColor: colors.bgElevated }}
          scrollbarOptions={{
            trackOptions: {
              foregroundColor: colors.accentSoft,
              backgroundColor: colors.border,
            },
          }}
        >
          <box flexDirection="column" paddingLeft={1} paddingRight={1} gap={1}>
            {messages.length === 0 && !streaming ? (
              <box paddingTop={1}>
                <text fg={colors.textMuted}>
                  {
                    "Type a message below to start chatting. The agent has context about the current ORC view and available skills."
                  }
                </text>
              </box>
            ) : null}
            {messages.map((msg, i) => (
              <box key={`${msg.timestamp}-${i}`} flexDirection="column">
                <text fg={msg.role === "user" ? colors.accent : colors.accentAlt}>
                  {msg.role === "user" ? "You" : agent}
                </text>
                <text fg={colors.text}>{msg.content}</text>
              </box>
            ))}
            {streaming && streamText ? (
              <box flexDirection="column">
                <text fg={colors.accentAlt}>{agent}</text>
                <text fg={colors.text}>{`${streamText}▌`}</text>
              </box>
            ) : streaming && !streamText ? (
              <box flexDirection="column">
                <text fg={colors.accentAlt}>{agent}</text>
                <text fg={colors.textMuted}>{"Thinking…"}</text>
              </box>
            ) : null}
          </box>
        </scrollbox>

        <box height={1}>
          <text fg={colors.border}>{"─".repeat(Math.max(4, boxWidth - 4))}</text>
        </box>

        <box
          flexDirection="row"
          gap={1}
          alignItems="center"
          paddingLeft={1}
          paddingRight={1}
          paddingTop={0}
          paddingBottom={0}
        >
          <text fg={colors.accent}>{">"}</text>
          <input
            focused={!streaming}
            value={inputValue}
            placeholder={streaming ? "Waiting for response…" : "Type a message…"}
            width={Math.max(10, boxWidth - 8)}
            backgroundColor={colors.bgElevated}
            textColor={colors.text}
            cursorColor={colors.accent}
            focusedBackgroundColor={colors.bgElevated}
            placeholderColor={colors.textMuted}
            onChange={onInputChange}
          />
        </box>
      </box>
    </box>
  );
}
