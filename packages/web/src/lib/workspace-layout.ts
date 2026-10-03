export type PaneKind = "terminal" | "git" | "files";
export type Pane = { id: string; kind: PaneKind; terminalId: string | null };
export type Layout =
  | Pane
  | { id: string; direction: "row" | "column"; ratio: number; first: Layout; second: Layout };
export function leaves(layout: Layout): Pane[] {
  return "kind" in layout ? [layout] : [...leaves(layout.first), ...leaves(layout.second)];
}
export function updateLayout(layout: Layout, id: string, update: (node: Layout) => Layout): Layout {
  if (layout.id === id) return update(layout);
  if ("kind" in layout) return layout;
  return {
    ...layout,
    first: updateLayout(layout.first, id, update),
    second: updateLayout(layout.second, id, update),
  };
}
export function closePane(layout: Layout, id: string): Layout {
  if ("kind" in layout) return layout;
  if (layout.first.id === id) return layout.second;
  if (layout.second.id === id) return layout.first;
  return { ...layout, first: closePane(layout.first, id), second: closePane(layout.second, id) };
}
export function readLayout(value: unknown, depth = 0): Layout | null {
  if (!value || typeof value !== "object" || depth > 7) return null;
  const node = value as Record<string, unknown>;
  if (typeof node.id !== "string" || node.id.length > 100) return null;
  if (
    ["terminal", "git", "files"].includes(String(node.kind)) &&
    (node.terminalId === null || typeof node.terminalId === "string")
  )
    return {
      id: node.id,
      kind: node.kind as PaneKind,
      terminalId: node.terminalId as string | null,
    };
  if (
    (node.direction !== "row" && node.direction !== "column") ||
    typeof node.ratio !== "number" ||
    !Number.isFinite(node.ratio)
  )
    return null;
  const first = readLayout(node.first, depth + 1);
  const second = readLayout(node.second, depth + 1);
  if (!first || !second) return null;
  const result: Layout = {
    id: node.id,
    direction: node.direction,
    ratio: Math.max(20, Math.min(80, node.ratio)),
    first,
    second,
  };
  const panes = leaves(result);
  if (panes.length > 8 || new Set(panes.map((pane) => pane.id)).size !== panes.length) return null;
  const terminals = panes
    .filter((pane) => pane.kind === "terminal" && pane.terminalId)
    .map((pane) => pane.terminalId);
  if (new Set(terminals).size !== terminals.length) return null;
  return result;
}
