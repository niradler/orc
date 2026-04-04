import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";
import { getScreenSize, type Route } from "../types.js";

type Props = {
  route: Route;
  project: string | null;
  detailId: string | null;
  connected: boolean;
  connectionError?: string | null;
};

const ROUTE_LABELS: Record<Route, string> = {
  projects: "Projects",
  tasks: "Tasks",
  jobs: "Jobs",
  memories: "Memories",
  sessions: "Sessions",
  prompts: "Prompts",
};

function trimTo(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

export function Header({ route, project, detailId, connected, connectionError }: Props) {
  const { width } = useTerminalDimensions();
  const screen = getScreenSize(width);
  const compact = screen === "xs";

  const contextParts = [ROUTE_LABELS[route]];
  if (project) contextParts.push(project);
  if (detailId) contextParts.push(trimTo(detailId, 12));
  const contextLabel = trimTo(contextParts.join("  /  "), compact ? width - 6 : width - 26);
  const statusText = connected ? "API online" : "API offline";
  const detail = connectionError
    ? trimTo(connectionError, Math.max(18, compact ? width - 6 : width - 54))
    : contextLabel;

  return (
    <box
      flexDirection="column"
      width={width}
      backgroundColor={colors.bgElevated}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      <box
        flexDirection={compact ? "column" : "row"}
        justifyContent="space-between"
        alignItems={compact ? "flex-start" : "center"}
        gap={compact ? 1 : 0}
      >
        <box flexDirection="row" gap={1} alignItems="center">
          <text fg={colors.logo}>{"⬡"}</text>
          <text fg={colors.text}>
            <strong>ORC</strong>
          </text>
          <text fg={colors.textMuted}>{"orchestration terminal"}</text>
        </box>
        <box
          flexDirection="row"
          gap={1}
          alignItems="center"
          backgroundColor={connected ? colors.bgLight : colors.bgSelected}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={connected ? colors.success : colors.error}>{connected ? "●" : "○"}</text>
          <text fg={connected ? colors.text : colors.error}>{statusText}</text>
        </box>
      </box>
      <box
        flexDirection={compact ? "column" : "row"}
        justifyContent="space-between"
        marginTop={1}
        gap={compact ? 1 : 0}
      >
        <box flexDirection="row" gap={1}>
          <text fg={colors.accent}>{"Workspace"}</text>
          <text fg={colors.text}>{contextLabel}</text>
        </box>
        <text fg={connectionError ? colors.warning : colors.textDim}>{detail}</text>
      </box>
      <box height={1} marginTop={1}>
        <text fg={colors.border}>{"─".repeat(Math.max(8, width - 2))}</text>
      </box>
    </box>
  );
}
