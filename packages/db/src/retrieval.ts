import type { Database, SQLQueryBindings } from "bun:sqlite";
import { ConflictError, ValidationError } from "@orc/core/errors";
import type {
  CitedPassage,
  EmbeddingProvider,
  EvidenceSource,
  Passage,
  RetrievalQuery,
  RetrievalResult,
} from "@orc/core/retrieval";
import { EvidenceSourceSchema, normalizeTags, RetrievalQuerySchema } from "@orc/core/retrieval";
import { evidenceVersion, segmentEvidence } from "./passages.js";

type StoredPassage = { payload: string; id: string; vector?: string };

export function installRetrieval(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS evidence_sources (
      kind TEXT NOT NULL, source_id TEXT NOT NULL, current_version TEXT NOT NULL,
      project_id TEXT, valid_until INTEGER, active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (kind, source_id)
    );
    CREATE TABLE IF NOT EXISTS evidence_versions (
      kind TEXT NOT NULL, source_id TEXT NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(kind, source_id, version)
    );
    CREATE TABLE IF NOT EXISTS evidence_passages (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_id TEXT NOT NULL, version TEXT NOT NULL,
      ordinal INTEGER NOT NULL, payload TEXT NOT NULL, content TEXT NOT NULL, title TEXT NOT NULL,
      tags TEXT NOT NULL, context TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS evidence_passage_source ON evidence_passages(kind, source_id, version, ordinal);
    CREATE INDEX IF NOT EXISTS evidence_source_scope ON evidence_sources(project_id, active, valid_until);
    CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(id UNINDEXED, content, title, tags, context, tokenize='porter unicode61');
    CREATE TABLE IF NOT EXISTS evidence_embeddings (
      passage_id TEXT NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL, vector TEXT NOT NULL,
      PRIMARY KEY(passage_id, model)
    );
  `);
}

export class PassageIndex {
  constructor(
    private readonly sqlite: Database,
    private readonly provider?: EmbeddingProvider,
  ) {
    installRetrieval(sqlite);
  }

  get(ids: string[], projectId: string | null): Passage[] {
    if (ids.length > 20) throw new ValidationError("Fetch at most 20 explicit citations");
    return [...new Set(ids)].flatMap((id) => {
      const row = this.sqlite
        .query<{ payload: string }, [string, string | null]>(
          "SELECT p.payload FROM evidence_passages p JOIN evidence_versions v ON v.kind=p.kind AND v.source_id=p.source_id AND v.version=p.version WHERE p.id=? AND json_extract(v.payload,'$.project_id') IS ?",
        )
        .get(id, projectId);
      return row ? [JSON.parse(row.payload) as Passage] : [];
    });
  }

  put(input: EvidenceSource): string {
    const source = EvidenceSourceSchema.parse(input);
    source.tags = normalizeTags(source.tags).sort();
    const version = evidenceVersion(source);
    this.sqlite.transaction(() => {
      const owner = this.sqlite
        .query<{ project_id: string | null }, [string, string]>(
          "SELECT project_id FROM evidence_sources WHERE kind=? AND source_id=?",
        )
        .get(source.kind, source.source_id);
      if (owner && owner.project_id !== source.project_id)
        throw new ConflictError(
          "Evidence identity belongs to another project; use a distinct source ID",
        );
      const existing = this.sqlite
        .query("SELECT 1 FROM evidence_versions WHERE kind=? AND source_id=? AND version=?")
        .get(source.kind, source.source_id, version);
      if (!existing) {
        this.sqlite
          .query("INSERT INTO evidence_versions(kind,source_id,version,payload) VALUES(?,?,?,?)")
          .run(source.kind, source.source_id, version, JSON.stringify(source));
        for (const passage of segmentEvidence(source)) {
          const context = [passage.headings.join(" > "), passage.structural_context]
            .filter(Boolean)
            .join("\n");
          this.sqlite
            .query(
              "INSERT INTO evidence_passages(id,kind,source_id,version,ordinal,payload,content,title,tags,context) VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              passage.id,
              source.kind,
              source.source_id,
              version,
              passage.ordinal,
              JSON.stringify(passage),
              passage.content,
              passage.title,
              JSON.stringify(passage.tags),
              context,
            );
          this.sqlite
            .query("INSERT INTO evidence_fts(id,content,title,tags,context) VALUES(?,?,?,?,?)")
            .run(passage.id, passage.content, passage.title, passage.tags.join(" "), context);
        }
      }
      this.sqlite
        .query(`INSERT INTO evidence_sources(kind,source_id,current_version,project_id,valid_until) VALUES(?,?,?,?,?)
        ON CONFLICT(kind,source_id) DO UPDATE SET current_version=excluded.current_version,project_id=excluded.project_id,valid_until=excluded.valid_until,active=1`)
        .run(source.kind, source.source_id, version, source.project_id, source.valid_until);
    })();
    return version;
  }

  retire(kind: string, sourceId: string): void {
    this.sqlite
      .query("UPDATE evidence_sources SET active=0 WHERE kind=? AND source_id=?")
      .run(kind, sourceId);
  }

  expand(id: string, projectId: string | null, radius = 1): Passage[] {
    if (!Number.isInteger(radius) || radius < 0 || radius > 3)
      throw new Error("Expansion radius must be 0–3");
    const row = this.sqlite
      .query<
        StoredPassage,
        [string, string | null]
      >(`SELECT p.payload,p.id FROM evidence_passages p JOIN evidence_sources s
      ON s.kind=p.kind AND s.source_id=p.source_id AND s.current_version=p.version
      WHERE p.id=? AND s.project_id IS ? AND s.active=1 AND (s.valid_until IS NULL OR s.valid_until>unixepoch())`)
      .get(id, projectId);
    if (!row) return [];
    const passage = JSON.parse(row.payload) as Passage;
    return this.sqlite
      .query<
        StoredPassage,
        [string, string, string, number, number]
      >(`SELECT payload,id FROM evidence_passages
      WHERE kind=? AND source_id=? AND version=? AND ordinal BETWEEN ? AND ? ORDER BY ordinal`)
      .all(
        passage.kind,
        passage.source_id,
        passage.version,
        passage.ordinal - radius,
        passage.ordinal + radius,
      )
      .map((item) => JSON.parse(item.payload) as Passage);
  }

  async embedSource(kind: string, sourceId: string): Promise<number> {
    if (!this.provider) return 0;
    const rows = this.sqlite
      .query<
        StoredPassage,
        [string, string, string]
      >(`SELECT p.id,p.payload FROM evidence_passages p JOIN evidence_sources s
      ON s.kind=p.kind AND s.source_id=p.source_id AND s.current_version=p.version
      LEFT JOIN evidence_embeddings e ON e.passage_id=p.id AND e.model=?
      WHERE s.active=1 AND p.kind=? AND p.source_id=? AND e.passage_id IS NULL`)
      .all(this.provider.model, kind, sourceId);
    for (let offset = 0; offset < rows.length; offset += 16) {
      const batch = rows.slice(offset, offset + 16);
      const vectors = await this.provider.embed(
        batch.map((row) => {
          const p = JSON.parse(row.payload) as Passage;
          return `${p.title}\n${p.headings.join(" > ")}\n${p.content}`;
        }),
      );
      if (vectors.length !== batch.length) throw new Error("Embedding count mismatch");
      this.sqlite.transaction(() => {
        batch.forEach((row, index) => {
          const vector = vectors[index];
          this.validateVector(vector);
          this.sqlite
            .query(
              "INSERT INTO evidence_embeddings(passage_id,model,dimensions,vector) VALUES(?,?,?,?) ON CONFLICT(passage_id,model) DO UPDATE SET dimensions=excluded.dimensions,vector=excluded.vector",
            )
            .run(row.id, this.provider?.model ?? "", vector.length, JSON.stringify(vector));
        });
      })();
    }
    return rows.length;
  }

  private validateVector(vector: number[] | undefined): asserts vector is number[] {
    if (
      !vector ||
      vector.length !== this.provider?.dimensions ||
      !vector.every(Number.isFinite) ||
      !vector.some((value) => value !== 0)
    )
      throw new Error("Invalid embedding vector");
  }

  async search(input: RetrievalQuery): Promise<RetrievalResult> {
    const options = RetrievalQuerySchema.parse(input);
    const params: SQLQueryBindings[] = [options.project_id];
    const constraints = [
      "s.project_id IS ?",
      "s.active=1",
      "(s.valid_until IS NULL OR s.valid_until>unixepoch())",
    ];
    if (options.kinds) {
      if (!options.kinds.length)
        return {
          passages: [],
          estimated_tokens: 0,
          capabilities: { lexical: true, semantic: this.provider ? "degraded" : "off" },
        };
      constraints.push(`p.kind IN (${options.kinds.map(() => "?").join(",")})`);
      params.push(...options.kinds);
    }
    for (const tag of normalizeTags(options.tags_all)) {
      constraints.push("EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value=?)");
      params.push(tag);
    }
    const anyTags = normalizeTags(options.tags_any);
    if (anyTags.length) {
      constraints.push(
        `EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value IN (${anyTags.map(() => "?").join(",")}))`,
      );
      params.push(...anyTags);
    }
    const join =
      "FROM evidence_passages p JOIN evidence_sources s ON s.kind=p.kind AND s.source_id=p.source_id AND s.current_version=p.version";
    const where = constraints.join(" AND ");
    const terms = options.query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    const expression = terms.map((term) => `"${term}"`).join(" OR ");
    const lexical = expression
      ? this.sqlite
          .query<StoredPassage, SQLQueryBindings[]>(
            `SELECT p.id,p.payload ${join} JOIN evidence_fts f ON f.id=p.id WHERE ${where} AND evidence_fts MATCH ? ORDER BY bm25(evidence_fts,0,1,3,1.5,2),p.id LIMIT 200`,
          )
          .all(...params, expression)
      : [];
    const candidates = new Map<string, { passage: Passage; score: number }>();
    function fuse(rows: StoredPassage[], weight: number): void {
      rows.forEach((row, rank) => {
        const entry = candidates.get(row.id) ?? {
          passage: JSON.parse(row.payload) as Passage,
          score: 0,
        };
        entry.score += weight / (60 + rank + 1);
        candidates.set(row.id, entry);
      });
    }
    fuse(lexical, 1);
    const topics = normalizeTags(options.topic_tags);
    if (topics.length) {
      const tagged = this.sqlite
        .query<StoredPassage, SQLQueryBindings[]>(
          `SELECT p.id,p.payload ${join} WHERE ${where} AND EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value IN (${topics.map(() => "?").join(",")})) ORDER BY p.id LIMIT 200`,
        )
        .all(...params, ...topics);
      fuse(tagged, 0.2);
    }
    const capabilities: RetrievalResult["capabilities"] = { lexical: true, semantic: "off" };
    if (this.provider) {
      try {
        const vectors = await this.provider.embed([options.query]);
        const queryVector = vectors[0];
        this.validateVector(queryVector);
        const rows = this.sqlite
          .query<StoredPassage & { vector: string }, SQLQueryBindings[]>(
            `SELECT p.id,p.payload,e.vector ${join} JOIN evidence_embeddings e ON e.passage_id=p.id WHERE ${where} AND e.model=? AND e.dimensions=? LIMIT 5000`,
          )
          .all(...params, this.provider.model, this.provider.dimensions);
        const norm = Math.hypot(...queryVector);
        const ranked = rows
          .map((row) => {
            const vector = JSON.parse(row.vector) as number[];
            this.validateVector(vector);
            return {
              row,
              score:
                vector.reduce((sum, value, index) => sum + value * (queryVector[index] ?? 0), 0) /
                (Math.hypot(...vector) * norm),
            };
          })
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 200);
        fuse(
          ranked.map((entry) => entry.row),
          1,
        );
        capabilities.semantic = rows.length ? "ready" : "degraded";
        if (!rows.length) capabilities.reason = "No embeddings for eligible passages";
      } catch {
        capabilities.semantic = "degraded";
        capabilities.reason =
          "Embedding provider unavailable or invalid response; lexical retrieval retained";
      }
    }
    const ranked = [...candidates.values()].sort(
      (a, b) => b.score - a.score || a.passage.id.localeCompare(b.passage.id),
    );
    const passages: CitedPassage[] = [];
    const seen = new Set<string>();
    let tokens = 0;
    for (const entry of ranked) {
      const p = entry.passage;
      const key = JSON.stringify([p.headings, p.structural_context, p.content.trim()]);
      const cost = Math.ceil(JSON.stringify(p).length / 4);
      if (seen.has(key) || tokens + cost > options.token_budget) continue;
      seen.add(key);
      tokens += cost;
      passages.push({ ...p, score: entry.score, estimated_tokens: cost });
      if (passages.length >= options.limit) break;
    }
    return { passages, estimated_tokens: tokens, capabilities };
  }
}
