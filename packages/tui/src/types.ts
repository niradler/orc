export type Route = "projects" | "tasks" | "jobs" | "memories" | "sessions" | "prompts";

export const ROUTES: Route[] = ["projects", "tasks", "jobs", "memories", "sessions", "prompts"];

export type ViewMode = "list" | "detail";

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
