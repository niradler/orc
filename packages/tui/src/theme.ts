export const colors = {
  bg: "#0d0d1a",
  bgLight: "#1a1a2e",
  bgHighlight: "#16213e",
  border: "#333355",
  borderFocus: "#00BFFF",
  text: "#DDDDDD",
  textDim: "#666666",
  textMuted: "#444444",
  accent: "#00BFFF",
  accentAlt: "#7B68EE",
  success: "#00FF7F",
  warning: "#FFD700",
  error: "#FF4444",
  critical: "#FF3333",
  logo: "#00BFFF",
} as const;

export const statusColor: Record<string, string> = {
  todo: "#888888",
  doing: "#00BFFF",
  review: "#FFD700",
  changes_requested: "#FF6B6B",
  blocked: "#FF4500",
  done: "#00FF7F",
  cancelled: "#555555",
};

export const priorityColor: Record<string, string> = {
  critical: "#FF3333",
  high: "#FF8C00",
  normal: "#CCCCCC",
  low: "#666666",
};

export const importanceColor: Record<string, string> = {
  critical: "#FF3333",
  high: "#FF8C00",
  normal: "#CCCCCC",
  low: "#666666",
};

export const jobStatusColor: Record<string, string> = {
  pending: "#888888",
  running: "#00BFFF",
  success: "#00FF7F",
  failed: "#FF4444",
  cancelled: "#555555",
  skipped: "#666666",
};

export const projectStatusColor: Record<string, string> = {
  active: "#00FF7F",
  archived: "#666666",
  paused: "#FFD700",
};

export function statusIcon(status: string): string {
  const map: Record<string, string> = {
    todo: "○",
    doing: "◉",
    review: "◎",
    changes_requested: "⟳",
    blocked: "✕",
    done: "✓",
    cancelled: "—",
    active: "●",
    archived: "○",
    paused: "◌",
    pending: "○",
    running: "◉",
    success: "✓",
    failed: "✕",
    skipped: "—",
  };
  return map[status] ?? "?";
}
