import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";
import type { Route, ViewState } from "../types.js";

type Props = {
  route: Route;
  state: ViewState;
};

const HINTS = {
  browse: "Arrows or j/k move • Enter open • / search • n new • e edit • d delete • : command",
  detail: "Esc back • Up/Down scroll • e edit • d delete",
  form: "Tab next • Shift+Tab prev • Ctrl+S save • Esc cancel",
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

export function StatusBar({ route, state }: Props) {
  const { width } = useTerminalDimensions();
  const modeLabel = state.mode.toUpperCase();
  const left = state.selectionLabel ?? ROUTE_HELP[route];
  const right = state.statusMessage ?? HINTS[state.mode];

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
      <box flexDirection="row" justifyContent="space-between">
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
