import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";
import { getScreenSize, ROUTES, type Route, type ViewState } from "../types.js";

type Props = {
  route: Route;
  state: ViewState;
  connected: boolean;
  project: string | null;
};

const HINTS = {
  browse: "↑↓ move • Enter open • / search • s sort • n new • : cmd",
  detail: "Esc back • ↑↓ scroll • e edit • d delete",
  form: "Tab next • S-Tab prev • C-S save • Esc cancel",
  filter: "Type to search • Enter done • Esc close",
  confirm: "Enter/y confirm • Esc/n cancel",
} as const;

const ROUTE_BROWSE_HINTS: Partial<Record<Route, string>> = {
  projects: "↑↓ move • Enter open • Space select • / search • s sort • n new • : cmd",
};

const TAB_KEYS: Record<Route, string> = {
  projects: "1",
  tasks: "2",
  skills: "3",
  memories: "4",
  knowledge: "5",
  jobs: "6",
  sessions: "7",
};

const TAB_SHORT: Record<Route, string> = {
  projects: "Projects",
  tasks: "Tasks",
  skills: "Skills",
  memories: "Memories",
  knowledge: "Knowledge",
  jobs: "Jobs",
  sessions: "Sessions",
};

export function StatusBar({ route, state, connected, project }: Props) {
  const { width } = useTerminalDimensions();
  const compact = getScreenSize(width) === "xs";
  const modeLabel = state.mode.toUpperCase();
  const defaultHint =
    state.mode === "browse" ? (ROUTE_BROWSE_HINTS[route] ?? HINTS.browse) : HINTS[state.mode];
  const hint = state.statusMessage ?? defaultHint;

  return (
    <box
      flexDirection="column"
      width={width}
      backgroundColor={colors.bgElevated}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
    >
      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <box flexDirection="row" gap={0} alignItems="center">
          {ROUTES.map((r) => (
            <box key={r} {...(route === r ? { backgroundColor: colors.bgSelected } : {})}>
              <text fg={route === r ? colors.text : colors.textMuted}>
                {` ${TAB_KEYS[r]}·${TAB_SHORT[r]} `}
              </text>
            </box>
          ))}
          {project ? <text fg={colors.accentAlt}>{`  ${project}`}</text> : null}
        </box>
        <box flexDirection="row" gap={1} alignItems="center">
          {state.sortLabel ? <text fg={colors.textDim}>{`sort:${state.sortLabel}`}</text> : null}
          <text fg={connected ? colors.success : colors.error}>{connected ? "●" : "○"}</text>
          <text fg={state.navigationLocked ? colors.warning : colors.accent}>{modeLabel}</text>
          {state.filterQuery ? <text fg={colors.textDim}>{`/${state.filterQuery}`}</text> : null}
        </box>
      </box>
      {!compact ? <text fg={colors.textMuted}>{hint}</text> : null}
    </box>
  );
}
