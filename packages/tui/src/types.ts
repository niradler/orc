import type { KeyEvent as OpenTUIKeyEvent } from "@opentui/core";

export type Route = "projects" | "tasks" | "jobs" | "memories" | "sessions" | "skills";

export const ROUTES: Route[] = ["projects", "tasks", "jobs", "memories", "sessions", "skills"];

export type ViewMode = "browse" | "detail" | "form" | "filter" | "confirm";

export type ScreenSize = "xs" | "sm" | "md" | "lg";

export const SCREEN_BREAKPOINTS = {
  xs: 72,
  sm: 96,
  md: 128,
} as const;

export function getScreenSize(width: number): ScreenSize {
  if (width < SCREEN_BREAKPOINTS.xs) return "xs";
  if (width < SCREEN_BREAKPOINTS.sm) return "sm";
  if (width < SCREEN_BREAKPOINTS.md) return "md";
  return "lg";
}

export type ViewState = {
  mode: ViewMode;
  title: string;
  countLabel: string;
  filterQuery: string;
  filterActive: boolean;
  navigationLocked: boolean;
  selectionLabel?: string | null;
  detailId?: string | null;
  statusMessage?: string | null;
};

export type Column<T> = {
  key: string;
  label: string;
  width: number;
  minWidth?: number;
  priority?: number;
  render: (item: T) => string;
  color?: (item: T) => string;
};

export type Command = {
  name: string;
  aliases: string[];
  description: string;
  action: () => void;
};

export type KeyEvent = OpenTUIKeyEvent;

export type ViewKeyHandler = (key: KeyEvent) => boolean;

export type SelectOption = {
  label: string;
  value: string;
  description?: string;
};
