export type Route = "projects" | "tasks" | "jobs" | "memories" | "sessions" | "prompts";

export const ROUTES: Route[] = ["projects", "tasks", "jobs", "memories", "sessions", "prompts"];

export type ViewMode = "browse" | "detail" | "form" | "filter" | "confirm";

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
  render: (item: T) => string;
  color?: (item: T) => string;
};

export type Command = {
  name: string;
  aliases: string[];
  description: string;
  action: () => void;
};

export type KeyEvent = {
  name: string;
  sequence: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  option: boolean;
  eventType: "press" | "release" | "repeat";
  repeated: boolean;
};

export type ViewKeyHandler = (key: KeyEvent) => boolean;

export type SelectOption = {
  label: string;
  value: string;
  description?: string;
};
