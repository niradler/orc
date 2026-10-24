import { Database } from "bun:sqlite";

/** `key` identifies the entry in the result (defaults to name, which is unique among skills). */
export type SkillSearchEntry = { name: string; description: string; key?: string };

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
      ranks.set(entry.key ?? entry.name, 0);
    }
  }
  return ranks;
}

/**
 * Ranks skills (or memories) against a keyword query with SQLite FTS5 (BM25, name weighted over description).
 * Requires every term (as a word prefix), then falls back to a plain substring match. Lower rank means more relevant;
 * entries missing from the map (by key) did not match.
 */
export function rankSkillMatches(entries: SkillSearchEntry[], query: string): Map<string, number> {
  const terms = buildPrefixTerms(query);
  if (terms.length === 0 || entries.length === 0) return rankBySubstring(entries, query);
  const index = new Database(":memory:");
  try {
    index.exec(
      "CREATE VIRTUAL TABLE skills_fts USING fts5(key UNINDEXED, name, description, tokenize='unicode61 remove_diacritics 2')",
    );
    const insert = index.prepare("INSERT INTO skills_fts(key, name, description) VALUES (?, ?, ?)");
    index.transaction(() => {
      for (const entry of entries)
        insert.run(entry.key ?? entry.name, entry.name, entry.description);
    })();
    const search = index.query<{ key: string; rank: number }, [string]>(
      `SELECT key, bm25(skills_fts, 0, ${NAME_WEIGHT}, ${DESCRIPTION_WEIGHT}) AS rank FROM skills_fts WHERE skills_fts MATCH ? ORDER BY rank`,
    );
    const rows = search.all(terms.join(" AND "));
    if (rows.length > 0) return new Map(rows.map((row) => [row.key, row.rank]));
  } finally {
    index.close();
  }
  return rankBySubstring(entries, query);
}

function normalizeSearch(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function searchWords(text: string): string[] {
  return normalizeSearch(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** One insertion, deletion, substitution or adjacent transposition. */
function nearWord(left: string, right: string): boolean {
  if (left.length < 4 || right.length < 4 || Math.abs(left.length - right.length) > 1) return false;
  let i = 0;
  while (i < left.length && left[i] === right[i]) i++;
  if (left.length === right.length) {
    return (
      left.slice(i + 1) === right.slice(i + 1) ||
      (left[i] === right[i + 1] &&
        left[i + 1] === right[i] &&
        left.slice(i + 2) === right.slice(i + 2))
    );
  }
  if (left.length > right.length) return left.slice(i + 1) === right.slice(i);
  return left.slice(i) === right.slice(i + 1);
}

/**
 * Hybrid lexical skill discovery: BM25 word prefixes and English stemming, combined
 * with exact/phrase boosts, infix recall and bounded typo matching. Every query term
 * must be covered. Scores are relative relevance, higher is better, not probabilities.
 * Kept separate from memory ranking so discovery changes do not alter memory behavior.
 */
export function scoreSkillMatches(entries: SkillSearchEntry[], query: string): Map<string, number> {
  const terms = [...new Set(searchWords(query))];
  const scores = new Map<string, number>();
  if (!terms.length || !entries.length) return scores;
  const index = new Database(":memory:");
  const lexical = new Map<string, number>();
  try {
    index.exec(
      "CREATE VIRTUAL TABLE prefix USING fts5(key UNINDEXED, name, description, tokenize='unicode61 remove_diacritics 2'); CREATE VIRTUAL TABLE stem USING fts5(key UNINDEXED, name, description, tokenize='porter unicode61 remove_diacritics 2')",
    );
    for (const table of ["prefix", "stem"]) {
      const insert = index.prepare(`INSERT INTO ${table}(key,name,description) VALUES(?,?,?)`);
      index.transaction(() => {
        for (const entry of entries)
          insert.run(entry.key ?? entry.name, entry.name, entry.description);
      })();
      const expression = terms
        .map((term) => `"${term}"${table === "prefix" ? "*" : ""}`)
        .join(" AND ");
      const rows = index
        .query<{ key: string }, [string]>(
          `SELECT key FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table},0,5,1),key`,
        )
        .all(expression);
      for (const [position, row] of rows.entries())
        lexical.set(row.key, (lexical.get(row.key) ?? 0) + 100 / (60 + position));
    }
  } finally {
    index.close();
  }
  const phrase = terms.join(" ");
  for (const entry of entries) {
    const key = entry.key ?? entry.name;
    const nameWords = searchWords(entry.name);
    const descriptionWords = searchWords(entry.description);
    let coverage = 0;
    let allCovered = true;
    for (const term of terms) {
      let quality = 0;
      if (nameWords.includes(term)) quality = 12;
      else if (nameWords.some((word) => word.startsWith(term))) quality = 9;
      else if (descriptionWords.includes(term)) quality = 6;
      else if (descriptionWords.some((word) => word.startsWith(term))) quality = 4;
      else if (term.length >= 3 && nameWords.some((word) => word.includes(term))) quality = 3;
      else if (term.length >= 3 && descriptionWords.some((word) => word.includes(term)))
        quality = 2;
      else if (nameWords.some((word) => nearWord(term, word))) quality = 1;
      else if (descriptionWords.some((word) => nearWord(term, word))) quality = 0.5;
      if (quality === 0) allCovered = false;
      coverage += quality;
    }
    if (!allCovered && !lexical.has(key)) continue;
    const name = nameWords.join(" ");
    const description = descriptionWords.join(" ");
    const boost =
      name === phrase
        ? 100
        : ` ${name} `.includes(` ${phrase} `)
          ? 30
          : ` ${description} `.includes(` ${phrase} `)
            ? 10
            : 0;
    scores.set(key, boost + coverage / terms.length + (lexical.get(key) ?? 0));
  }
  return scores;
}
