import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";
import type { PaletteCategory, PaletteCommand } from "../types.js";

type Props = {
  open: boolean;
  input: string;
  cursor: number;
  results: PaletteCommand[];
};

const CATEGORY_LABELS: Record<PaletteCategory, string> = {
  navigation: "NAVIGATION",
  sort: "SORT",
  filter: "FILTER",
  search: "SEARCH",
  action: "ACTION",
  system: "SYSTEM",
};

type RenderItem =
  | { type: "header"; label: string }
  | { type: "command"; command: PaletteCommand; resultIndex: number };

function buildRenderItems(results: PaletteCommand[]): RenderItem[] {
  const items: RenderItem[] = [];
  let lastCategory: PaletteCategory | null = null;

  for (let i = 0; i < results.length; i++) {
    const cmd = results[i]!;
    if (cmd.category !== lastCategory) {
      items.push({ type: "header", label: CATEGORY_LABELS[cmd.category] ?? cmd.category });
      lastCategory = cmd.category;
    }
    items.push({ type: "command", command: cmd, resultIndex: i });
  }

  return items;
}

const HINTS = [
  { key: "/ <text>", desc: "Search in current view" },
  { key: "sort <column>", desc: "Sort by column (asc/desc)" },
  { key: "filter <f>=<v>", desc: "Filter by field value" },
  { key: "tasks, jobs, ...", desc: "Navigate to view" },
  { key: "chat", desc: "Open chat" },
  { key: "quit", desc: "Exit TUI" },
];

export function SmartPalette({ open, input, cursor, results }: Props) {
  const { width, height } = useTerminalDimensions();

  if (!open) return null;

  const boxWidth = Math.min(60, width - 4);
  const showHints = input.length === 0;
  const renderItems = showHints ? [] : buildRenderItems(results);
  const maxVisible = 12;

  // Scroll window: find the render item containing the cursor, keep it visible
  let scrollOffset = 0;
  if (!showHints && renderItems.length > maxVisible) {
    // Find which render item corresponds to the cursor
    const cursorItemIdx = renderItems.findIndex(
      (item) => item.type === "command" && item.resultIndex === cursor,
    );
    if (cursorItemIdx >= maxVisible) {
      scrollOffset = cursorItemIdx - maxVisible + 1;
    }
  }

  const visibleItems = showHints ? [] : renderItems.slice(scrollOffset, scrollOffset + maxVisible);
  const contentHeight = showHints ? HINTS.length + 2 : Math.min(renderItems.length, maxVisible) + 1;
  const totalHeight = contentHeight + 4; // input + border + footer
  const top = Math.max(0, Math.floor((height - totalHeight) / 2));

  return (
    <box
      position="absolute"
      top={top}
      left={Math.floor((width - boxWidth) / 2)}
      width={boxWidth}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={colors.accent}
      backgroundColor={colors.bg}
      paddingLeft={1}
      paddingRight={1}
      zIndex={100}
    >
      {/* Input line */}
      <box flexDirection="row" gap={0} marginBottom={0}>
        <text fg={colors.accent}>{":"}</text>
        <text fg={colors.text}>{input}</text>
        <text fg={colors.accent}>{"█"}</text>
      </box>

      {/* Separator */}
      <text fg={colors.border}>{"─".repeat(boxWidth - 4)}</text>

      {/* Hints (empty state) */}
      {showHints && (
        <box flexDirection="column" paddingTop={0} paddingBottom={0}>
          {HINTS.map((h) => (
            <box key={h.key} flexDirection="row">
              <text fg={colors.accent} width={20}>
                {"  " + h.key}
              </text>
              <text fg={colors.textDim}>{h.desc}</text>
            </box>
          ))}
        </box>
      )}

      {/* Results */}
      {!showHints && results.length === 0 && input.length > 0 && (
        <text fg={colors.textDim} paddingLeft={1}>
          {"No matching commands"}
        </text>
      )}

      {!showHints &&
        visibleItems.map((item, idx) => {
          if (item.type === "header") {
            return (
              <text key={`h-${item.label}`} fg={colors.textMuted}>
                {"  " + item.label}
              </text>
            );
          }
          const isSelected = item.resultIndex === cursor;
          const cmd = item.command;
          const icon = cmd.icon ? cmd.icon + " " : "  ";
          const hint = cmd.hint ? `  ${cmd.hint}` : "";
          return (
            <box
              key={cmd.id}
              flexDirection="row"
              {...(isSelected ? { backgroundColor: colors.bgSelected } : {})}
            >
              <text fg={isSelected ? colors.accent : colors.text}>
                {isSelected ? "▸ " : "  "}
                {icon}
                {cmd.name}
              </text>
              {hint && (
                <text fg={colors.textDim}>{hint}</text>
              )}
              {cmd.shortcut && (
                <text fg={colors.textMuted}>{`  [${cmd.shortcut}]`}</text>
              )}
            </box>
          );
        })}

      {/* Footer */}
      <text fg={colors.textMuted}>
        {showHints
          ? "  Type to search · ↑↓ select · Esc close"
          : "  ↑↓ navigate · Enter select · Esc close"}
      </text>
    </box>
  );
}
