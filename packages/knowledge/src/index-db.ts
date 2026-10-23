import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ParsedBlock } from "@orc/core/kb";
import type { Chunk } from "./chunker.js";
import {
  cosineDistance,
  decodeVector,
  encodeVector,
  loadVectorBackend,
  type VectorBackend,
} from "./vector.js";

const INDEX_SCHEMA_VERSION = 2;

function rankedChunksSql(query: string, metric: "score" | "distance", perDocument?: number) {
  if (!perDocument) return `${query} ORDER BY ${metric}, id LIMIT ?`;
  return `WITH candidates AS MATERIALIZED (${query}), ranked AS (
    SELECT id, document_id, ${metric}, row_number() OVER (
      PARTITION BY document_id ORDER BY ${metric}, id
    ) AS position FROM candidates
  ) SELECT id, document_id, ${metric} FROM ranked WHERE position <= ? ORDER BY ${metric}, id LIMIT ?`;
}

export type IndexedChunk = {
  id: number;
  document_id: string;
  kb_id: string;
  revision: number;
  ordinal: number;
  title: string;
  heading_path: string[];
  locator: ParsedBlock["locator"] | null;
  text: string;
  labels: string[];
  media_type: string;
};

export type ChunkFilter = { kb_ids: string[]; labels?: string[]; media_types?: string[] };
export type DocumentIndexInput = {
  document_id: string;
  kb_id: string;
  revision: number;
  title: string;
  labels: string[];
  media_type: string;
  chunks: Chunk[];
};

type ChunkRow = Omit<IndexedChunk, "heading_path" | "locator" | "labels"> & {
  heading_path: string;
  locator: string | null;
  labels: string;
};

const toChunk = (r: ChunkRow): IndexedChunk => ({
  ...r,
  heading_path: JSON.parse(r.heading_path) as string[],
  locator: r.locator ? (JSON.parse(r.locator) as IndexedChunk["locator"]) : null,
  labels: JSON.parse(r.labels) as string[],
});

/** What gets embedded: the title and heading trail give short passages their context. */
export const embeddingInput = (c: Pick<IndexedChunk, "title" | "heading_path" | "text">) =>
  [c.title, c.heading_path.join(" > "), c.text].filter(Boolean).join("\n\n");

export const inputHash = (text: string) => createHash("sha256").update(text).digest("hex");

/** FTS5 query from free text: every term quoted (no syntax injection), last term as a prefix. */
export function ftsQuery(query: string, op: "AND" | "OR"): string | null {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
  if (!terms.length) return null;
  return terms
    .map((t, i) => `"${t}"${i === terms.length - 1 && t.length >= 3 ? "*" : ""}`)
    .join(` ${op} `);
}

/**
 * Rebuildable search index (chunks, FTS5, vectors, embedding cache) at <knowledge root>/index.db.
 * orc.db stays authoritative; losing this file only costs a reindex.
 */
export class IndexDb {
  readonly db: Database;
  backend: VectorBackend = "exact-scan";
  backendDetail: string | undefined;

  private constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;",
    );
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    if (version !== 0 && version !== INDEX_SCHEMA_VERSION) {
      // Derived data only: drop and let reconcile() requeue every document.
      this.db.exec(
        "DROP TABLE IF EXISTS chunk_vectors; DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS embed_cache;",
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        document_id TEXT NOT NULL,
        kb_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        title TEXT NOT NULL,
        heading_path TEXT NOT NULL,
        locator TEXT,
        text TEXT NOT NULL,
        labels TEXT NOT NULL,
        media_type TEXT NOT NULL,
        input_hash TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS chunks_doc_idx ON chunks(document_id, ordinal);
      CREATE INDEX IF NOT EXISTS chunks_kb_idx ON chunks(kb_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        title, headings, labels, text, tokenize = 'unicode61 remove_diacritics 2'
      );
      -- A rowid table on purpose: vectors are kilobytes, and WITHOUT ROWID rows that large
      -- spill to overflow pages that made each KNN scan ~9x slower.
      CREATE TABLE IF NOT EXISTS chunk_vectors (
        chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        profile TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS chunk_vectors_key ON chunk_vectors(profile, chunk_id);
      CREATE INDEX IF NOT EXISTS chunk_vectors_chunk_idx ON chunk_vectors(chunk_id);
      CREATE TABLE IF NOT EXISTS embed_cache (
        profile TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        embedding BLOB NOT NULL,
        PRIMARY KEY (profile, input_hash)
      ) WITHOUT ROWID;
      PRAGMA user_version = ${INDEX_SCHEMA_VERSION};
    `);
  }

  static async open(path: string): Promise<IndexDb> {
    const idx = new IndexDb(path);
    const { backend, detail } = await loadVectorBackend(idx.db);
    idx.backend = backend;
    idx.backendDetail = detail;
    return idx;
  }

  close() {
    this.db.close();
  }

  /** Replaces a document's chunks atomically; unchanged passages keep their cached embeddings. */
  replaceDocument(doc: DocumentIndexInput) {
    const insert = this.db.query(
      `INSERT INTO chunks (document_id, kb_id, revision, ordinal, title, heading_path, locator, text, labels, media_type, input_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const fts = this.db.query(
      "INSERT INTO chunks_fts (rowid, title, headings, labels, text) VALUES (?, ?, ?, ?, ?)",
    );
    this.db.transaction(() => {
      this.deleteDocument(doc.document_id);
      for (const c of doc.chunks) {
        const hash = inputHash(embeddingInput({ ...c, title: doc.title }));
        const res = insert.run(
          doc.document_id,
          doc.kb_id,
          doc.revision,
          c.ordinal,
          doc.title,
          JSON.stringify(c.heading_path),
          c.locator ? JSON.stringify(c.locator) : null,
          c.text,
          JSON.stringify(doc.labels),
          doc.media_type,
          hash,
        );
        const id = Number(res.lastInsertRowid);
        fts.run(id, doc.title, c.heading_path.join(" "), doc.labels.join(" "), c.text);
      }
    })();
  }

  deleteDocument(documentId: string) {
    const ids = this.db.query("SELECT id FROM chunks WHERE document_id = ?").all(documentId) as {
      id: number;
    }[];
    if (!ids.length) return;
    const delFts = this.db.query("DELETE FROM chunks_fts WHERE rowid = ?");
    this.db.transaction(() => {
      for (const { id } of ids) delFts.run(id);
      this.db.run("DELETE FROM chunks WHERE document_id = ?", [documentId]);
    })();
  }

  deleteKb(kbId: string) {
    const docs = this.db
      .query("SELECT DISTINCT document_id FROM chunks WHERE kb_id = ?")
      .all(kbId) as { document_id: string }[];
    for (const d of docs) this.deleteDocument(d.document_id);
  }

  documentChunkCounts(): Map<string, number> {
    const rows = this.db
      .query("SELECT document_id, count(*) n FROM chunks GROUP BY document_id")
      .all() as { document_id: string; n: number }[];
    return new Map(rows.map((r) => [r.document_id, r.n]));
  }

  chunkCount(): number {
    return (this.db.query("SELECT count(*) n FROM chunks").get() as { n: number }).n;
  }

  getChunks(ids: number[]): IndexedChunk[] {
    const unique = [...new Set(ids)];
    const chunks: IndexedChunk[] = [];
    for (let offset = 0; offset < unique.length; offset += 500) {
      const batch = unique.slice(offset, offset + 500);
      const rows = this.db
        .query(`SELECT * FROM chunks WHERE id IN (${batch.map(() => "?").join(",")})`)
        .all(...batch) as (ChunkRow & { input_hash?: string })[];
      chunks.push(...rows.map(({ input_hash: _, ...r }) => toChunk(r)));
    }
    return chunks;
  }

  documentChunks(documentId: string): IndexedChunk[] {
    const rows = this.db
      .query("SELECT * FROM chunks WHERE document_id = ? ORDER BY ordinal")
      .all(documentId) as (ChunkRow & { input_hash?: string })[];
    return rows.map(({ input_hash: _, ...r }) => toChunk(r));
  }

  private filterSql(f: ChunkFilter, alias: string): { sql: string; params: string[] } {
    const parts = [`${alias}.kb_id IN (${f.kb_ids.map(() => "?").join(",")})`];
    const params = [...f.kb_ids];
    if (f.labels?.length) {
      parts.push(
        `EXISTS (SELECT 1 FROM json_each(${alias}.labels) WHERE value IN (${f.labels.map(() => "?").join(",")}))`,
      );
      params.push(...f.labels);
    }
    if (f.media_types?.length) {
      parts.push(`${alias}.media_type IN (${f.media_types.map(() => "?").join(",")})`);
      params.push(...f.media_types);
    }
    return { sql: parts.join(" AND "), params };
  }

  /** BM25 over title/headings/labels/text; AND first, widened to OR when AND is too narrow. */
  lexical(
    query: string,
    f: ChunkFilter,
    limit: number,
    perDocument?: number,
  ): { id: number; score: number }[] {
    if (!f.kb_ids.length) return [];
    const filter = this.filterSql(f, "c");
    const run = (q: string) =>
      this.db
        .query(
          rankedChunksSql(
            `SELECT c.id, c.document_id, bm25(chunks_fts, 4.0, 2.0, 2.0, 1.0) AS score
           FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
           WHERE chunks_fts MATCH ? AND ${filter.sql}`,
            "score",
            perDocument,
          ),
        )
        .all(q, ...filter.params, ...(perDocument ? [perDocument] : []), limit) as {
        id: number;
        document_id: string;
        score: number;
      }[];
    const cap = (hits: ReturnType<typeof run>) => {
      const counts = new Map<string, number>();
      return hits
        .filter((hit) => {
          if (!perDocument) return true;
          const count = counts.get(hit.document_id) ?? 0;
          counts.set(hit.document_id, count + 1);
          return count < perDocument;
        })
        .slice(0, limit)
        .map(({ id, score }) => ({ id, score }));
    };
    const and = ftsQuery(query, "AND");
    if (!and) return [];
    const hits = run(and);
    if (hits.length >= Math.min(limit, 5)) return cap(hits);
    const or = ftsQuery(query, "OR");
    if (!or || or === and) return cap(hits);
    const seen = new Set(hits.map((h) => h.id));
    return cap([...hits, ...run(or).filter((h) => !seen.has(h.id))]);
  }

  /** Exact cosine KNN over the eligible rows (filters apply before ranking, not after). */
  semantic(vector: number[], profile: string, f: ChunkFilter, limit: number, perDocument?: number) {
    if (!f.kb_ids.length) return [];
    const filter = this.filterSql(f, "c");
    if (this.backend === "sqlite-vec") {
      const rows = this.db
        .query(
          rankedChunksSql(
            `SELECT v.chunk_id AS id, c.document_id, vec_distance_cosine(v.embedding, ?) AS distance
           FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id
           WHERE v.profile = ? AND ${filter.sql}`,
            "distance",
            perDocument,
          ),
        )
        .all(
          encodeVector(vector),
          profile,
          ...filter.params,
          ...(perDocument ? [perDocument] : []),
          limit,
        ) as {
        id: number;
        distance: number;
      }[];
      return rows.map(({ id, distance }) => ({ id, distance }));
    }
    const q = Float32Array.from(vector);
    const rows = this.db
      .query(
        `SELECT v.chunk_id AS id, c.document_id, v.embedding FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id
         WHERE v.profile = ? AND ${filter.sql}`,
      )
      .all(profile, ...filter.params) as {
      id: number;
      document_id: string;
      embedding: Uint8Array;
    }[];
    const counts = new Map<string, number>();
    return rows
      .map((r) => ({
        id: r.id,
        document_id: r.document_id,
        distance: cosineDistance(q, decodeVector(r.embedding)),
      }))
      .sort((a, b) => a.distance - b.distance || a.id - b.id)
      .filter((row) => {
        if (!perDocument) return true;
        const count = counts.get(row.document_id) ?? 0;
        counts.set(row.document_id, count + 1);
        return count < perDocument;
      })
      .slice(0, limit)
      .map(({ id, distance }) => ({ id, distance }));
  }

  /** Dimensions of the vectors stored for this profile (float32), or null before the first. */
  vectorDimensions(profile: string): number | null {
    const row = this.db
      .query("SELECT length(embedding) / 4 AS n FROM chunk_vectors WHERE profile = ? LIMIT 1")
      .get(profile) as { n: number } | null;
    return row?.n ?? null;
  }

  /** Chunks still lacking a vector for this profile, optionally for one document. */
  pendingEmbeddings(profile: string, limit: number, documentId?: string) {
    return this.db
      .query(
        `SELECT c.id, c.title, c.heading_path, c.text, c.input_hash FROM chunks c
         LEFT JOIN chunk_vectors v ON v.chunk_id = c.id AND v.profile = ?
         WHERE v.chunk_id IS NULL ${documentId ? "AND c.document_id = ?" : ""}
         ORDER BY c.id LIMIT ?`,
      )
      .all(...(documentId ? [profile, documentId, limit] : [profile, limit]))
      .map((r) => {
        const row = r as {
          id: number;
          title: string;
          heading_path: string;
          text: string;
          input_hash: string;
        };
        return { ...row, heading_path: JSON.parse(row.heading_path) as string[] };
      });
  }

  pendingEmbeddingCount(profile: string): number {
    return (
      this.db
        .query(
          `SELECT count(*) n FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk_id = c.id AND v.profile = ?
           WHERE v.chunk_id IS NULL`,
        )
        .get(profile) as { n: number }
    ).n;
  }

  cachedEmbedding(profile: string, hash: string): Uint8Array | null {
    const row = this.db
      .query("SELECT embedding FROM embed_cache WHERE profile = ? AND input_hash = ?")
      .get(profile, hash) as { embedding: Uint8Array } | null;
    return row?.embedding ?? null;
  }

  putVectors(profile: string, rows: { chunk_id: number; hash: string; vector: Uint8Array }[]) {
    const vec = this.db.query(
      "INSERT OR REPLACE INTO chunk_vectors (chunk_id, profile, embedding) VALUES (?, ?, ?)",
    );
    const cache = this.db.query(
      "INSERT OR REPLACE INTO embed_cache (profile, input_hash, embedding) VALUES (?, ?, ?)",
    );
    // The chunk may have been replaced by a newer revision while the embedding call was in flight.
    const exists = this.db.query("SELECT 1 FROM chunks WHERE id = ? AND input_hash = ?");
    this.db.transaction(() => {
      for (const r of rows) {
        cache.run(profile, r.hash, r.vector);
        if (exists.get(r.chunk_id, r.hash)) vec.run(r.chunk_id, profile, r.vector);
      }
    })();
  }

  /** True when every chunk of the document has a vector for this profile. */
  fullyEmbedded(profile: string, documentId: string): boolean {
    return !this.db
      .query(
        `SELECT 1 FROM chunks c LEFT JOIN chunk_vectors v ON v.chunk_id = c.id AND v.profile = ?
         WHERE c.document_id = ? AND v.chunk_id IS NULL LIMIT 1`,
      )
      .get(profile, documentId);
  }
}
