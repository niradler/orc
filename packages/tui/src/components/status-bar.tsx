import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";
import type { Route, ViewState } from "../types.js";

type Props = {
  route: Route;
  state: ViewState;
};

const HINTS = {
  browse: "Arrows or j/k move • Enter open • / search • n new • : command",
  detail: "Esc back • Up/Down scroll • e edit • d delete",
  form: "Tab next • Shift+Tab prev • Ctrl+S or F2 save • Esc cancel",
  filter: "Type to search • Enter done • Esc close",
  confirm: "Enter or y confirm • Esc or n cancel",
} as const;

const ROUTE_HELP: Record<Route, string> = {
  projects: "Choose a project to scope the rest of ORC.",
  tasks: "Track active work, owners, status, and review flow.",
  jobs: "Inspect scheduled automation and run history.",
  memories: "Browse and capture searchable project knowledge.",
  sessions: "Review agent sessions, summaries, and snapshots.",
  prompts: "Manage reusable prompts and skills.",
};

function trimTo(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return text.slice(0, 1);
  return `${text.slice(0, width - 1)}…`;
}

export function StatusBar({ route, state }: Props) {
  const { width } = useTerminalDimensions();
  const compact = width < 76;
  const modeLabel = state.mode.toUpperCase();
  const left = trimTo(state.selectionLabel ?? ROUTE_HELP[route], compact ? width - 8 : width - 28);
  const right = trimTo(state.statusMessage ?? HINTS[state.mode], Math.max(24, width - 4));

  return (
    <box
      flexDirection="column"
      width={width}
      backgroundColor={colors.bgElevated}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
    >
      <box
        flexDirection={compact ? "column" : "row"}
        justifyContent="space-between"
        gap={compact ? 1 : 0}
      >
        <text fg={colors.text}>{left}</text>
        <box
          flexDirection="row"
          gap={1}
          backgroundColor={state.navigationLocked ? colors.bgSelected : colors.bgLight}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={state.navigationLocked ? colors.warning : colors.accent}>{modeLabel}</text>
          {state.filterQuery ? <text fg={colors.textDim}>{`/${state.filterQuery}`}</text> : null}
        </box>
      </box>
      <text fg={colors.textMuted}>{right}</text>
    </box>
  );
}
