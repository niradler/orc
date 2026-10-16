import { Database } from "bun:sqlite";

export type SkillSearchEntry = { name: string; description: string };

const NAME_WEIGHT = 5.0;
const DESCRIPTION_WEIGHT = 1.0;

function buildPrefixTerms(query: string): string[] {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.map((token) => `"${token}"*`);
}

function rankBySubstring(entries: SkillSearchEntry[], query: string): Map<string, number> {
  const needle = query.trim().toLowerCase();
  const ranks = new Map<string, number>();
  if (!needle) return ranks;
  for (const entry of entries) {
    if (
      entry.name.toLowerCase().includes(needle) ||
      entry.description.toLowerCase().includes(needle)
    ) {
      ranks.set(entry.name, 0);
    }
  }
  return ranks;
}

/**
 * Ranks skills against a keyword query with SQLite FTS5 (BM25, name weighted over description).
 * Requires every term (as a word prefix), then falls back to a plain substring match. Lower rank means more relevant;
 * skills missing from the map did not match.
 */
export function rankSkillMatches(entries: SkillSearchEntry[], query: string): Map<string, number> {
  const terms = buildPrefixTerms(query);
  if (terms.length === 0 || entries.length === 0) return rankBySubstring(entries, query);
  const index = new Database(":memory:");
  try {
    index.exec(
      "CREATE VIRTUAL TABLE skills_fts USING fts5(name, description, tokenize='unicode61 remove_diacritics 2')",
    );
    const insert = index.prepare("INSERT INTO skills_fts(name, description) VALUES (?, ?)");
    index.transaction(() => {
      for (const entry of entries) insert.run(entry.name, entry.description);
    })();
    const search = index.query<{ name: string; rank: number }, [string]>(
      `SELECT name, bm25(skills_fts, ${NAME_WEIGHT}, ${DESCRIPTION_WEIGHT}) AS rank FROM skills_fts WHERE skills_fts MATCH ? ORDER BY rank`,
    );
    const rows = search.all(terms.join(" AND "));
    if (rows.length > 0) return new Map(rows.map((row) => [row.name, row.rank]));
  } finally {
    index.close();
  }
  return rankBySubstring(entries, query);
}
