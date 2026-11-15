import { CHAT_ITEM_WINDOW, type ChatActivity, type ChatItem, type ChatTurn } from "@orc/core/chat";
import { type ChatTool, type ToolView, toolView } from "./chat-tools";

export type TurnTiming = Partial<ChatTurn>;
export type TurnFold = {
  tools: number;
  thoughts: number;
  failed: number;
  running: number;
  files: string[];
  added: number;
  removed: number;
  commands: number;
  /** Kinds this build does not render, counted so the summary never drops them. */
  provider: number;
  durationMs: number | null;
  current: ChatTool | null;
};

/** Filters narrow tool calls inside an expanded turn; narration and plans stay. */
export type ActivityFilter = "all" | "changes" | "commands" | "failed";
export const ACTIVITY_FILTERS: readonly ActivityFilter[] = ["all", "changes", "commands", "failed"];
export const ACTIVITY_FILTER_LABELS: Record<ActivityFilter, string> = {
  all: "All",
  changes: "Changes",
  commands: "Commands",
  failed: "Failed",
};
export type ActivityPrefs = { filter: ActivityFilter; hideSuccessful: boolean };
export const DEFAULT_ACTIVITY_PREFS: ActivityPrefs = { filter: "all", hideSuccessful: false };
export const ACTIVITY_PREFS_KEY = "orc_chat_activity_prefs";

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes / 60}h`;
}

export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours
    ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
    : `${minutes}:${pad(seconds % 60)}`;
}

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** The legacy activity shape a row renderer needs; provider items have no renderer here. */
export function chatItemActivity(item: ChatItem): ChatActivity | null {
  if (item.kind === "provider") return null;
  if (item.kind === "tool") return toolItemActivity(item);
  if (item.kind === "plan")
    return {
      type: "plan",
      id: item.id,
      ...(item.title === undefined ? {} : { title: item.title }),
      entries: item.entries,
    };
  if (item.kind === "thinking") return { type: "thinking", id: item.id, text: item.text };
  return { type: "status", id: item.id, text: item.text };
}

function toolItemActivity(item: ToolItem): ChatTool {
  return {
    type: "tool",
    id: item.id,
    name: item.name,
    input: item.input,
    ...(item.result === undefined ? {} : { result: item.result }),
    ...(item.isError === undefined ? {} : { isError: item.isError }),
  };
}

function isTool(item: ChatItem): item is ToolItem {
  return item.kind === "tool";
}

function toolKind(tool: ToolItem): ToolView["kind"] {
  return toolView(toolItemActivity(tool)).kind;
}

/** Which filters a tool call belongs to; a failed edit is both a change and a failure. */
function inFilter(tool: ToolItem, filter: ActivityFilter): boolean {
  if (filter === "all") return true;
  if (filter === "failed") return tool.isError === true;
  const kind = toolKind(tool);
  if (filter === "changes") return kind === "edit" || kind === "write";
  return kind === "run";
}

export function activityCounts(items: ChatItem[]): Record<ActivityFilter, number> {
  const tools = items.filter(isTool);
  return {
    all: tools.length,
    changes: tools.filter((tool) => inFilter(tool, "changes")).length,
    commands: tools.filter((tool) => inFilter(tool, "commands")).length,
    failed: tools.filter((tool) => inFilter(tool, "failed")).length,
  };
}

/**
 * Selects the rows to show. Narration, thinking, plans and unknown provider
 * activities are not tool calls, so they stay visible under every filter;
 * failures are never hidden by "hide successful".
 */
export function filterActivity(items: ChatItem[], prefs: ActivityPrefs): ChatItem[] {
  return items.filter((item) => {
    if (!isTool(item)) return true;
    if (!inFilter(item, prefs.filter)) return false;
    return !(prefs.hideSuccessful && !item.isError && item.result !== undefined);
  });
}

/**
 * The rows an expanded turn renders: the newest window, or everything once the
 * turn's "show all" control is used. `hidden` counts what is still folded away.
 */
export function windowChatItems(
  items: ChatItem[],
  showAll: boolean,
  size = CHAT_ITEM_WINDOW,
): { shown: ChatItem[]; hidden: number } {
  const hidden = showAll ? 0 : Math.max(0, items.length - size);
  return { shown: hidden ? items.slice(hidden) : items, hidden };
}

export function parseActivityPrefs(raw: string | null | undefined): ActivityPrefs {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const filter = ACTIVITY_FILTERS.includes(record.filter as ActivityFilter)
        ? (record.filter as ActivityFilter)
        : DEFAULT_ACTIVITY_PREFS.filter;
      return { filter, hideSuccessful: record.hideSuccessful === true };
    }
  } catch {}
  return { ...DEFAULT_ACTIVITY_PREFS };
}

export function activityPrefsJson(prefs: ActivityPrefs): string {
  return JSON.stringify({
    filter: ACTIVITY_FILTERS.includes(prefs.filter) ? prefs.filter : "all",
    hideSuccessful: prefs.hideSuccessful === true,
  });
}

export function foldTurn(items: ChatItem[], timing: TurnTiming = {}): TurnFold {
  const tools = items.filter(isTool);
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  let commands = 0;
  for (const tool of tools) {
    if (tool.isError) continue;
    const view = toolView(toolItemActivity(tool));
    if (view.kind === "edit" || view.kind === "write")
      for (const file of view.files) {
        files.add(file.path);
        added += file.added;
        removed += file.removed;
      }
    if (view.kind === "run") commands++;
  }
  const elapsed =
    timing.durationMs ??
    (timing.startedAt !== undefined && timing.finishedAt !== undefined
      ? timing.finishedAt - timing.startedAt
      : null);
  const pending = tools.filter((tool) => tool.result === undefined);
  const current = pending[pending.length - 1];
  return {
    tools: tools.length,
    thoughts: items.filter((item) => item.kind === "thinking").length,
    failed: tools.filter((tool) => tool.isError === true).length,
    running: pending.length,
    files: [...files],
    added,
    removed,
    commands,
    provider: items.filter((item) => item.kind === "provider").length,
    durationMs: elapsed !== null && elapsed >= 1000 ? elapsed : null,
    current: current ? toolItemActivity(current) : null,
  };
}

/**
 * Summary phrases in reading order: what was done, how many files changed,
 * command count when nothing changed, and failures. Failure is separate so the
 * collapsed row can keep its status icon and error color.
 */
export function foldCounts(fold: TurnFold, includeFailure = true): string[] {
  const churn = fold.added || fold.removed ? ` (+${fold.added} −${fold.removed})` : "";
  return [
    fold.tools ? plural(fold.tools, "tool") : "",
    fold.files.length ? `${plural(fold.files.length, "file")} changed${churn}` : "",
    fold.tools && !fold.files.length && fold.commands ? plural(fold.commands, "command") : "",
    includeFailure && fold.failed ? `${fold.failed} failed` : "",
    !fold.tools && fold.thoughts ? plural(fold.thoughts, "thought") : "",
    fold.provider
      ? `${fold.provider} unrecognized ${fold.provider === 1 ? "activity" : "activities"}`
      : "",
  ].filter(Boolean);
}

export function foldFailure(fold: TurnFold): string | null {
  return fold.failed ? `${fold.failed} failed` : null;
}

function foldHead(fold: TurnFold, live: boolean, outcome?: ChatTurn["outcome"]): string {
  let head = "Worked";
  if (live) head = "Working";
  else if (outcome === "stopped") head = "Stopped";
  else if (outcome === "failed") head = "Failed";
  if (!live && fold.durationMs !== null)
    head += `${outcome === "stopped" || outcome === "failed" ? " after" : " for"} ${formatDuration(fold.durationMs)}`;
  return head;
}

/** The visible sentence without the failure phrase, which the row renders separately. */
export function foldSummary(
  fold: TurnFold,
  live = false,
  outcome?: ChatTurn["outcome"],
): { text: string; failure: string | null } {
  return {
    text: [foldHead(fold, live, outcome), ...foldCounts(fold, false)].join(" · "),
    failure: foldFailure(fold),
  };
}

export function foldLabel(fold: TurnFold, live = false, outcome?: ChatTurn["outcome"]): string {
  const summary = foldSummary(fold, live, outcome);
  return summary.failure ? `${summary.text} · ${summary.failure}` : summary.text;
}
