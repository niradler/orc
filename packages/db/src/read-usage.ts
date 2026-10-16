import { rankSkillMatches } from "./skill-search.js";

// Read tracking shared by skills and memories: reads are counted per source, and only agent
// reads (mcp, cli, api) rank items; ui views are shown but do not move anything.

/** Where a read came from; `ui` is a person browsing the web app, the rest are agents. */
export type ReadSource = "mcp" | "cli" | "api" | "ui";
export type ReadsBySource = Record<ReadSource, number>;
export type ReadUsage = {
  /** Agent reads (mcp + cli + api); drives the "reads" sort. */
  read_count: number;
  /** Reads per source, including ui. */
  reads_by_source: ReadsBySource;
  /** Latest agent read. */
  last_read_at: number | null;
};
export type ListSort = "reads" | "recent";
export type RankedItem = {
  /** Unique within the ranked list; defaults to name. */
  key?: string;
  name: string;
  description: string;
  read_count: number;
  /** Last read, else last update, else creation. */
  activity_at: number;
};

/** Attributes a read to the calling client header; unknown callers count as plain API reads. */
export function readSourceFromClient(client: string | undefined): ReadSource {
  return client === "cli" || client === "ui" ? client : "api";
}

export function emptyReadUsage(): ReadUsage {
  return { read_count: 0, reads_by_source: { mcp: 0, cli: 0, api: 0, ui: 0 }, last_read_at: null };
}

/** Adds one (name, source) aggregate row to the usage stats. */
export function addReads(
  stats: ReadUsage,
  source: ReadSource,
  reads: number,
  lastReadAt: number | null,
): void {
  stats.reads_by_source[source] += reads;
  if (source === "ui") return;
  stats.read_count += reads;
  if (lastReadAt !== null) stats.last_read_at = Math.max(stats.last_read_at ?? 0, lastReadAt);
}

export function compareByReads(left: RankedItem, right: RankedItem): number {
  return (
    right.read_count - left.read_count ||
    right.activity_at - left.activity_at ||
    left.name.localeCompare(right.name)
  );
}

export function compareByRecent(left: RankedItem, right: RankedItem): number {
  return (
    right.activity_at - left.activity_at ||
    right.read_count - left.read_count ||
    left.name.localeCompare(right.name)
  );
}

/** Sorts items, or with a query keeps only matches ranked by FTS (name x5 + description) first. */
export function rankItems<T extends RankedItem>(
  items: T[],
  compare: (left: T, right: T) => number,
  q?: string,
): T[] {
  if (!q) return items.sort(compare);
  const ranks = rankSkillMatches(items, q);
  const rank = (item: T): number => ranks.get(item.key ?? item.name) ?? 0;
  return items
    .filter((item) => ranks.has(item.key ?? item.name))
    .sort((left, right) => rank(left) - rank(right) || compare(left, right));
}
