import type { Database } from "bun:sqlite";
import { getDb } from "@orc/db/client";

export type MemoryLayer1 = {
  id: string;
  snippet: string;
  scope: string | null;
  type: string;
  importance: string;
  age: string;
  rank: number;
  matchLayer: "porter" | "trigram" | "fallback";
};

export type MemoryLayer2 = MemoryLayer1 & {
  title: string | null;
  full_content: string;
  before: MemoryLayer1[];
  after: MemoryLayer1[];
};

export type MemoryLayer3 = {
  id: string;
  title: string | null;
  type: string;
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
  title: string | null;
  type: string;
  content: string;
  scope: string | null;
  importance: string;
  created_at: number;
  updated_at: number;
  source: string | null;
  tags: string | null;
  expires_at: number | null;
};

const SELECT_COLS = `m.id, m.title, m.type, m.content, m.scope, m.importance,
  m.created_at, m.updated_at, m.source, m.tags, m.expires_at`;

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

function toLayer1(
  row: RawMemRow,
  rank: number,
  matchLayer: MemoryLayer1["matchLayer"],
): MemoryLayer1 {
  return {
    id: row.id,
    snippet: snippet(row.content),
    scope: row.scope,
    type: row.type ?? "fact",
    importance: row.importance,
    age: timeAgo(row.created_at),
    rank,
    matchLayer,
  };
}

function getSqlite(): Database {
  const db = getDb();
  return (db as unknown as { $client: Database }).$client;
}

function buildScopeTypeFilter(
  scope?: string,
  type?: string,
  project_id?: string,
): { clause: string; params: (string | null)[] } {
  const conditions: string[] = [];
  const params: (string | null)[] = [];
  if (scope) {
    conditions.push("m.scope = ?");
    params.push(scope);
  }
  if (type) {
    conditions.push("m.type = ?");
    params.push(type);
  }
  if (project_id) {
    conditions.push("m.project_id = ?");
    params.push(project_id);
  }
  return {
    clause: conditions.length ? ` AND ${conditions.join(" AND ")}` : "",
    params,
  };
}

function ftsQuery(
  sqlite: Database,
  table: "memories_fts" | "memories_fts_trigram",
  matchExpr: string,
  scope: string | undefined,
  type: string | undefined,
  limit: number,
  project_id?: string,
): RawMemRow[] {
  const { clause, params } = buildScopeTypeFilter(scope, type, project_id);
  const sql = `SELECT ${SELECT_COLS}
    FROM ${table} f JOIN memories m ON m.id = f.id
    WHERE f.${table} MATCH ?${clause}
    ORDER BY rank LIMIT ?`;
  try {
    return sqlite.query(sql).all(matchExpr, ...params, limit) as RawMemRow[];
  } catch {
    return [];
  }
}

function buildPorterExpr(query: string, mode: "AND" | "OR"): string {
  const words = query
    .replace(/["]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0] as string;
  return words.join(` ${mode} `);
}

function buildTrigramExpr(query: string, mode: "AND" | "OR"): string {
  return buildPorterExpr(query, mode);
}

export function searchLayer1(
  query: string,
  scope?: string,
  limit = 10,
  type?: string,
  project_id?: string,
): MemoryLayer1[] {
  const sqlite = getSqlite();
  const trimmed = query.trim();
  if (!trimmed) return [];

  const seen = new Set<string>();

  function dedupe(rows: RawMemRow[], layer: MemoryLayer1["matchLayer"]): MemoryLayer1[] {
    const out: MemoryLayer1[] = [];
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        out.push(toLayer1(r, seen.size, layer));
      }
    }
    return out;
  }

  const results: MemoryLayer1[] = [];

  const porterAnd = ftsQuery(
    sqlite,
    "memories_fts",
    buildPorterExpr(trimmed, "AND"),
    scope,
    type,
    limit,
    project_id,
  );
  results.push(...dedupe(porterAnd, "porter"));
  if (results.length >= limit) return renumber(results.slice(0, limit));

  const porterOr = ftsQuery(
    sqlite,
    "memories_fts",
    buildPorterExpr(trimmed, "OR"),
    scope,
    type,
    limit,
    project_id,
  );
  results.push(...dedupe(porterOr, "porter"));
  if (results.length >= limit) return renumber(results.slice(0, limit));

  const trigramAnd = ftsQuery(
    sqlite,
    "memories_fts_trigram",
    buildTrigramExpr(trimmed, "AND"),
    scope,
    type,
    limit,
    project_id,
  );
  results.push(...dedupe(trigramAnd, "trigram"));
  if (results.length >= limit) return renumber(results.slice(0, limit));

  const trigramOr = ftsQuery(
    sqlite,
    "memories_fts_trigram",
    buildTrigramExpr(trimmed, "OR"),
    scope,
    type,
    limit,
    project_id,
  );
  results.push(...dedupe(trigramOr, "trigram"));
  if (results.length >= limit) return renumber(results.slice(0, limit));

  if (results.length === 0) {
    const { clause, params } = buildScopeTypeFilter(scope, type, project_id);
    const allParams: (string | number | null)[] = [`%${trimmed.toLowerCase()}%`, ...params, limit];
    const fallbackRows = sqlite
      .query(
        `SELECT ${SELECT_COLS} FROM memories m
         WHERE m.content LIKE ?${clause}
         ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(...allParams) as RawMemRow[];
    results.push(...dedupe(fallbackRows, "fallback"));
  }

  return renumber(results.slice(0, limit));
}

function renumber(items: MemoryLayer1[]): MemoryLayer1[] {
  return items.map((m, i) => ({ ...m, rank: i + 1 }));
}

export function getLayer2(id: string, windowSize = 3): MemoryLayer2 | null {
  const sqlite = getSqlite();

  const target = sqlite
    .query<RawMemRow, string>(`SELECT ${SELECT_COLS} FROM memories m WHERE m.id = ?`)
    .get(id);

  if (!target) return null;

  const before = sqlite
    .query<RawMemRow, [number, number]>(
      `SELECT ${SELECT_COLS} FROM memories m WHERE m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(target.created_at, windowSize);

  const after = sqlite
    .query<RawMemRow, [number, number]>(
      `SELECT ${SELECT_COLS} FROM memories m WHERE m.created_at > ? ORDER BY m.created_at ASC LIMIT ?`,
    )
    .all(target.created_at, windowSize);

  return {
    ...toLayer1(target, 1, "porter"),
    title: target.title,
    full_content: target.content,
    before: before.map((r, i) => toLayer1(r, i + 1, "porter")),
    after: after.map((r, i) => toLayer1(r, i + 1, "porter")),
  };
}

export function getLayer3(ids: string[]): MemoryLayer3[] {
  if (ids.length === 0) return [];
  const sqlite = getSqlite();
  const placeholders = ids.map(() => "?").join(",");
  const rows = sqlite
    .query<RawMemRow, string[]>(
      `SELECT ${SELECT_COLS} FROM memories m WHERE m.id IN (${placeholders})`,
    )
    .all(...ids);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type ?? "fact",
    content: r.content,
    source: r.source,
    scope: r.scope,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : null,
    importance: r.importance,
    created_at: new Date(r.created_at * 1000).toISOString(),
    updated_at: new Date(r.updated_at * 1000).toISOString(),
  }));
}
