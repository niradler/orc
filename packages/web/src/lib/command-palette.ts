import type { GlobalSearchHit } from "@/api/client";
import type { AgentState } from "./agent-state";
import { MEMORIES_PATH, memoryPath } from "./memory-routes";
import { needsUser, SESSION_FILTER_LABELS, SESSION_FILTERS } from "./session-filter";

/** Never interpret a result title or ID as a URL. */
export function searchHitPath(hit: GlobalSearchHit): string {
  const id = encodeURIComponent(hit.id);
  switch (hit.kind) {
    case "task":
      return `/tasks/${id}`;
    case "project":
      return `/projects/${id}`;
    case "job":
      return `/jobs/${id}`;
    case "memory":
      // Memory hits are keyed by name, unique only within their project.
      return hit.project_id
        ? memoryPath(hit.project_id, hit.id)
        : `${MEMORIES_PATH}?memoryQuery=${id}`;
    case "session":
      return `/audit/${id}`;
  }
}

export function commandMatches(label: string, keywords: string, query: string): boolean {
  const haystack = `${label} ${keywords}`.toLocaleLowerCase();
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

export const JUMP_SHORTCUT = { label: "Alt J", aria: "Alt+J" } as const;

export function isJumpShortcut(
  event: Pick<KeyboardEvent, "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): boolean {
  return (
    event.code === "KeyJ" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
  );
}

export type JumpTarget = { id: string; state: AgentState; at: number };
export type JumpKind = "any" | "needs-you" | "done";

/** Sessions that need the user come first, then unseen Done, newest first; skips this round's visits. */
export function nextJump<T extends JumpTarget>(
  targets: readonly T[],
  visited: ReadonlySet<string>,
  kind: JumpKind = "any",
): T | undefined {
  const newest = (a: T, b: T) => b.at - a.at || a.id.localeCompare(b.id);
  const urgent = kind === "done" ? [] : targets.filter((t) => needsUser(t.state)).sort(newest);
  const done = kind === "needs-you" ? [] : targets.filter((t) => t.state === "done").sort(newest);
  const order = [...urgent, ...done];
  return order.find((target) => !visited.has(target.id)) ?? order[0];
}

export const STATE_FILTER_COMMANDS = SESSION_FILTERS.map((filter) => ({
  id: `sessions-state-${filter}`,
  title: filter === "all" ? "Show all sessions" : `Show sessions: ${SESSION_FILTER_LABELS[filter]}`,
  path: filter === "all" ? "/sessions" : `/sessions?state=${filter}`,
}));
