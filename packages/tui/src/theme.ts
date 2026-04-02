export const colors = {
  bg: "#0b1118",
  bgElevated: "#101822",
  bgLight: "#16202b",
  bgHighlight: "#1d2a36",
  bgSelected: "#1c2533",
  border: "#233244",
  borderFocus: "#6d8cff",
  text: "#e5edf5",
  textDim: "#9cacbf",
  textMuted: "#72839b",
  accent: "#78a6ff",
  accentAlt: "#f0a35e",
  accentSoft: "#b08dff",
  success: "#6ed7a6",
  warning: "#e4bc64",
  error: "#ef7f7f",
  critical: "#ff6b6b",
  info: "#7db7ff",
  logo: "#78a6ff",
} as const;

export const statusColor: Record<string, string> = {
  todo: "#91a3b7",
  doing: "#78a6ff",
  review: "#e4bc64",
  changes_requested: "#ef9a9a",
  blocked: "#f28b82",
  done: "#6ed7a6",
  cancelled: "#6d7b8f",
};

export const priorityColor: Record<string, string> = {
  critical: "#ff7f7f",
  high: "#f0a35e",
  normal: "#d7e0ea",
  low: "#8ea1b6",
};

export const importanceColor: Record<string, string> = {
  critical: "#ff7f7f",
  high: "#f0a35e",
  normal: "#d7e0ea",
  low: "#8ea1b6",
};

export const jobStatusColor: Record<string, string> = {
  pending: "#91a3b7",
  running: "#78a6ff",
  success: "#6ed7a6",
  failed: "#ef7f7f",
  cancelled: "#6d7b8f",
  skipped: "#8ea1b6",
};

export const projectStatusColor: Record<string, string> = {
  active: "#6ed7a6",
  archived: "#8ea1b6",
  paused: "#e4bc64",
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
