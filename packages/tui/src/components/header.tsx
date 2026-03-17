import { useTerminalDimensions } from "@opentui/react";
import { colors } from "../theme.js";
import type { Route } from "../types.js";

type Props = {
  route: Route;
  project: string | null;
  detailId: string | null;
  connected: boolean;
};

export function Header({ route, project, detailId, connected }: Props) {
  const { width } = useTerminalDimensions();

  const crumbs: string[] = ["orc"];
  if (project) crumbs.push(project);
  crumbs.push(route);
  if (detailId) crumbs.push(detailId);
  const breadcrumb = crumbs.join(" > ");

  return (
    <box
      flexDirection="row"
      width={width}
      height={1}
      backgroundColor={colors.bg}
      justifyContent="space-between"
    >
      <box flexDirection="row" gap={0}>
        <text fg={colors.logo} paddingLeft={1}>
          {"⬡ "}
        </text>
        <text fg={colors.accent}>{breadcrumb}</text>
      </box>
      <box flexDirection="row" gap={1} paddingRight={1}>
        <text fg={connected ? colors.success : colors.error}>{connected ? "●" : "○"}</text>
        <text fg={colors.textDim}>{connected ? "connected" : "disconnected"}</text>
      </box>
    </box>
  );
}
