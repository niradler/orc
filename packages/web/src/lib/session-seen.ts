import type { AgentState } from "./agent-state";

export const SEEN_KEY = "orc_session_seen";
const MAX_ENTRIES = 2000;

/** Per-client record of when each session was last viewed. `since` is when this client started tracking. */
export type SeenRecord = { since: number; seen: Record<string, number> };

export function parseSeen(raw: string | null, now: number): SeenRecord {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (
      value &&
      typeof value === "object" &&
      "since" in value &&
      typeof value.since === "number" &&
      "seen" in value &&
      value.seen &&
      typeof value.seen === "object"
    ) {
      const seen: Record<string, number> = {};
      for (const [key, at] of Object.entries(value.seen))
        if (typeof at === "number" && Number.isFinite(at)) seen[key] = at;
      return { since: value.since, seen };
    }
  } catch {}
  return { since: now, seen: {} };
}

export function lastSeen(record: SeenRecord, keys: readonly string[]): number {
  return keys.reduce((latest, key) => Math.max(latest, record.seen[key] ?? 0), record.since);
}

export function withSeen(record: SeenRecord, keys: readonly string[], at: number): SeenRecord {
  if (keys.every((key) => (record.seen[key] ?? 0) >= at)) return record;
  const seen = { ...record.seen };
  for (const key of keys) seen[key] = Math.max(seen[key] ?? 0, at);
  const entries = Object.entries(seen);
  if (entries.length <= MAX_ENTRIES) return { since: record.since, seen };
  entries.sort((a, b) => b[1] - a[1]);
  return { since: record.since, seen: Object.fromEntries(entries.slice(0, MAX_ENTRIES)) };
}

/** A finished session reads Done until this client has seen its latest activity. */
export function unseenState(state: AgentState, finishedAt: number, seenAt: number): AgentState {
  return (state === "idle" || state === "ended") && finishedAt > seenAt ? "done" : state;
}

let record: SeenRecord | null = null;
const listeners = new Set<() => void>();

function read(): SeenRecord {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SEEN_KEY);
  } catch {}
  const parsed = parseSeen(raw, Date.now());
  if (!raw) write(parsed);
  return parsed;
}

function write(next: SeenRecord) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {}
}

export function getSeen(): SeenRecord {
  record ??= read();
  return record;
}

export function markSeen(keys: readonly string[], at = Date.now()): void {
  const current = getSeen();
  const next = withSeen(current, keys, at);
  if (next === current) return;
  record = next;
  write(next);
  for (const listener of listeners) listener();
}

export function subscribeSeen(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SEEN_KEY) return;
    record = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
