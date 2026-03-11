import type { Database } from "bun:sqlite";
import { getDb } from "@orc/db/client";
import { memories } from "@orc/db/schema";
import { desc, eq } from "drizzle-orm";

export type MemoryLayer1 = {
  id: string;
  snippet: string;
  scope: string | null;
  importance: string;
  age: string;
  rank: number;
};

export type MemoryLayer2 = MemoryLayer1 & {
  full_content: string;
  before: MemoryLayer1[];
  after: MemoryLayer1[];
};

export type MemoryLayer3 = {
  id: string;
  content: string;
  source: string | null;
  scope: string | null;
  tags: string[] | null;
  importance: string;
  created_at: string;
  updated_at: string;
};

type RawMemRow = {
  id: string;
  content: string;
  scope: string | null;
  importance: string;
  created_at: number;
  updated_at: number;
  source: string | null;
  tags: string | null;
  expires_at: number | null;
};

function snippet(content: string, maxLen = 80): string {
  return content.length <= maxLen ? content : `${content.slice(0, maxLen - 1)}…`;
}

function timeAgo(epochSeconds: number): string {
  const ms = Date.now() - epochSeconds * 1000;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function toLayer1(row: RawMemRow, rank: number): MemoryLayer1 {
  return {
    id: row.id,
    snippet: snippet(row.content),
    scope: row.scope,
    importance: row.importance,
    age: timeAgo(row.created_at),
    rank,
  };
}

function getSqlite(): Database {
  const db = getDb();
  return (db as unknown as { $client: Database }).$client;
}

export function searchLayer1(query: string, scope?: string, limit = 10): MemoryLayer1[] {
  const sqlite = getSqlite();
  const safe = query.replace(/["]/g, " ").trim();
  if (!safe) return [];

  try {
    const sql = scope
      ? `SELECT m.id, m.content, m.scope, m.importance, m.created_at, m.updated_at,
                m.source, m.tags, m.expires_at
         FROM memories_fts f
         JOIN memories m ON m.id = f.id
         WHERE f.memories_fts MATCH ? AND m.scope = ?
         ORDER BY rank
         LIMIT ?`
      : `SELECT m.id, m.content, m.scope, m.importance, m.created_at, m.updated_at,
                m.source, m.tags, m.expires_at
         FROM memories_fts f
         JOIN memories m ON m.id = f.id
         WHERE f.memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`;

    const rows = scope
      ? (sqlite.query(sql).all(safe, scope, limit) as RawMemRow[])
      : (sqlite.query(sql).all(safe, limit) as RawMemRow[]);

    return rows.map((r, i) => toLayer1(r, i + 1));
  } catch {
    const q = query.toLowerCase();
    const fallback = sqlite
      .query(
        `SELECT id, content, scope, importance, created_at, updated_at, source, tags, expires_at
         FROM memories
         WHERE content LIKE ? ${scope ? "AND scope = ?" : ""}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...(scope ? [`%${q}%`, scope, limit] : [`%${q}%`, limit])) as RawMemRow[];

    return fallback.map((r, i) => toLayer1(r, i + 1));
  }
}

export function getLayer2(id: string, windowSize = 3): MemoryLayer2 | null {
  const sqlite = getSqlite();

  const target = sqlite
    .query<RawMemRow, string>(
      `SELECT id, content, scope, importance, created_at, updated_at, source, tags, expires_at
       FROM memories WHERE id = ?`,
    )
    .get(id);

  if (!target) return null;

  const before = sqlite
    .query<RawMemRow, [number, number]>(
      `SELECT id, content, scope, importance, created_at, updated_at, source, tags, expires_at
       FROM memories WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(target.created_at, windowSize);

  const after = sqlite
    .query<RawMemRow, [number, number]>(
      `SELECT id, content, scope, importance, created_at, updated_at, source, tags, expires_at
       FROM memories WHERE created_at > ? ORDER BY created_at ASC LIMIT ?`,
    )
    .all(target.created_at, windowSize);

  return {
    ...toLayer1(target, 1),
    full_content: target.content,
    before: before.map((r, i) => toLayer1(r, i + 1)),
    after: after.map((r, i) => toLayer1(r, i + 1)),
  };
}

export function getLayer3(ids: string[]): MemoryLayer3[] {
  if (ids.length === 0) return [];
  const sqlite = getSqlite();
  const placeholders = ids.map(() => "?").join(",");
  const rows = sqlite
    .query<RawMemRow, string[]>(
      `SELECT id, content, scope, importance, created_at, updated_at, source, tags, expires_at
       FROM memories WHERE id IN (${placeholders})`,
    )
    .all(...ids);

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    source: r.source,
    scope: r.scope,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : null,
    importance: r.importance,
    created_at: new Date(r.created_at * 1000).toISOString(),
    updated_at: new Date(r.updated_at * 1000).toISOString(),
  }));
}
