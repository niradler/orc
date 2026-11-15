import type { AgentState } from "./agent-state";

export const SESSION_FILTERS = ["all", "needs-you", "working", "done"] as const;
export type SessionFilter = (typeof SESSION_FILTERS)[number];

export const SESSION_FILTER_LABELS: Record<SessionFilter, string> = {
  all: "All",
  "needs-you": "Needs you",
  working: "Working",
  done: "Done",
};

/** A failure is a request for the user's attention, so it counts as Needs you. */
export function needsUser(state: AgentState): boolean {
  return state === "needs-you" || state === "failed";
}

export function matchesFilter(state: AgentState, filter: SessionFilter): boolean {
  if (filter === "all") return true;
  if (filter === "needs-you") return needsUser(state);
  return state === filter;
}

export function filterCounts(states: Iterable<AgentState>): Record<SessionFilter, number> {
  const counts: Record<SessionFilter, number> = { all: 0, "needs-you": 0, working: 0, done: 0 };
  for (const state of states) {
    counts.all++;
    for (const filter of SESSION_FILTERS)
      if (filter !== "all" && matchesFilter(state, filter)) counts[filter]++;
  }
  return counts;
}

export function parseFilter(value: string | null | undefined): SessionFilter {
  return SESSION_FILTERS.find((filter) => filter === value) ?? "all";
}

export const SESSION_FILTER_KEY = "orc_chat_history_filter";
const SESSION_FILTER_EVENT = "orc:session-filter";

/**
 * Store the filter and tell an already-mounted session list to apply it: the
 * command palette can run from the chat page, where navigating to /chat again
 * does not remount the list.
 */
export function applySessionFilter(filter: SessionFilter) {
  try {
    localStorage.setItem(SESSION_FILTER_KEY, filter);
  } catch {}
  window.dispatchEvent(new CustomEvent<SessionFilter>(SESSION_FILTER_EVENT, { detail: filter }));
}

export function onSessionFilterChange(handler: (filter: SessionFilter) => void) {
  const listener = (event: Event) =>
    handler(parseFilter((event as CustomEvent<string | undefined>).detail));
  window.addEventListener(SESSION_FILTER_EVENT, listener);
  return () => window.removeEventListener(SESSION_FILTER_EVENT, listener);
}
