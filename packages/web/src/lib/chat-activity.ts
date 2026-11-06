import type { ChatActivity } from "@orc/core/chat";
import { type ChatTool, toolView } from "./chat-tools";

export type TurnTiming = { startedAt?: number | undefined; finishedAt?: number | undefined };
export type TurnFold = {
  tools: number;
  thoughts: number;
  failed: number;
  running: number;
  files: string[];
  durationMs: number | null;
  current: ChatTool | null;
};

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

export function foldTurn(activity: ChatActivity[], timing: TurnTiming = {}): TurnFold {
  const tools = activity.filter((item): item is ChatTool => item.type === "tool");
  const files = new Set<string>();
  for (const tool of tools) {
    if (tool.isError) continue;
    const view = toolView(tool);
    if (view.kind === "edit") for (const file of view.files) files.add(file.path);
  }
  const elapsed =
    timing.startedAt && timing.finishedAt ? timing.finishedAt - timing.startedAt : null;
  const pending = tools.filter((tool) => tool.result === undefined);
  return {
    tools: tools.length,
    thoughts: activity.filter((item) => item.type === "thinking").length,
    failed: tools.filter((tool) => tool.isError).length,
    running: pending.length,
    files: [...files],
    durationMs: elapsed !== null && elapsed >= 1000 ? elapsed : null,
    current: pending[pending.length - 1] ?? null,
  };
}

export function foldCounts(fold: TurnFold): string[] {
  return [
    fold.tools ? plural(fold.tools, "tool") : "",
    fold.files.length ? `${plural(fold.files.length, "file")} changed` : "",
    !fold.tools && fold.thoughts ? plural(fold.thoughts, "thought") : "",
  ].filter(Boolean);
}

export function foldLabel(fold: TurnFold, live = false): string {
  const head = live
    ? "Working"
    : fold.durationMs !== null
      ? `Worked for ${formatDuration(fold.durationMs)}`
      : "Worked";
  return [head, ...foldCounts(fold)].join(" · ");
}
