import type {
  KbEvidencePack,
  KbEvidenceRequest,
  KbPassage,
  KbSearchHit,
  KbSearchRequest,
  KbSearchResult,
} from "@orc/core/kb";
import { KbEvidenceSchema, KbSearchSchema } from "@orc/core/kb";
import { DOC_COLUMNS, type DocRow, type KbRow } from "./catalog.js";
import { estimateTokens } from "./chunker.js";
import type { Engine } from "./engine.js";
import type { ChunkFilter, IndexedChunk } from "./index-db.js";

const RRF_K = 60;
const CANDIDATES = 60;
const PASSAGES_PER_HIT = 3;

export const citationOf = (c: Pick<IndexedChunk, "document_id" | "revision" | "ordinal">) =>
  `kb:${c.document_id}@${c.revision}#${c.ordinal}`;

const CITATION = /^kb:([A-Za-z0-9_-]+)@(\d+)#(\d+)$/;
export function parseCitation(handle: string) {
  const m = CITATION.exec(handle.trim());
  return m ? { document_id: m[1] as string, revision: Number(m[2]), ordinal: Number(m[3]) } : null;
}

const terms = (q: string) =>
  [
    ...new Set((q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length >= 2)),
  ].slice(0, 16);

/** ~240-char window around the first matched term, with matches marked «term». */
export function snippet(text: string, query: string, width = 240): string {
  const ts = terms(query);
  const lower = text.toLowerCase();
  const first = ts.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const at = first.length ? Math.min(...first) : 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  let out = text
    .slice(start, start + width)
    .replace(/\s+/g, " ")
    .trim();
  if (start > 0) out = `…${out}`;
  if (start + width < text.length) out = `${out}…`;
  if (!ts.length) return out;
  const re = new RegExp(
    `(${ts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "giu",
  );
  return out.replace(re, "«$1»");
}

export type ScopeInput = Pick<KbSearchRequest, "scope" | "kb_ids">;

/**
 * KBs a call may read. default = the active project's KBs plus global ones; project = only the
 * active project's; global = only global; all = every KB. Explicit kb_ids narrow the scope.
 */
export function scopeKbs(
  e: Engine,
  input: ScopeInput,
  projectId: string | readonly string[] | null | undefined,
): KbRow[] {
  const scope = input.scope ?? "default";
  let rows: KbRow[];
  if (typeof projectId === "object" && projectId !== null) {
    const placeholders = projectId.map(() => "?").join(",") || "NULL";
    const predicate =
      scope === "global"
        ? "project_id IS NULL"
        : scope === "project"
          ? `project_id IN (${placeholders})`
          : `(project_id IS NULL OR project_id IN (${placeholders}))`;
    rows = e.db
      .query(`SELECT * FROM knowledge_bases WHERE ${predicate}`)
      .all(...(scope === "global" ? [] : projectId)) as KbRow[];
  } else if (scope === "all") rows = e.db.query("SELECT * FROM knowledge_bases").all() as KbRow[];
  else if (scope === "global")
    rows = e.db.query("SELECT * FROM knowledge_bases WHERE project_id IS NULL").all() as KbRow[];
  else if (scope === "project")
    rows = projectId
      ? (e.db.query("SELECT * FROM knowledge_bases WHERE project_id = ?").all(projectId) as KbRow[])
      : [];
  else
    rows = e.db
      .query("SELECT * FROM knowledge_bases WHERE project_id IS NULL OR project_id = ?")
      .all(projectId ?? "") as KbRow[];
  if (input.kb_ids?.length) {
    const wanted = new Set(input.kb_ids);
    rows = rows.filter((k) => wanted.has(k.id));
  }
  return rows;
}

type Ranked = {
  doc: DocRow;
  kb: KbRow;
  score: number;
  matched: Set<"exact" | "lexical" | "semantic">;
  chunks: number[];
};

export class Searcher {
  constructor(private readonly e: Engine) {}

  async search(
    raw: KbSearchRequest,
    projectId: string | readonly string[] | null | undefined,
  ): Promise<KbSearchResult> {
    const req = KbSearchSchema.parse(raw);
    const t0 = performance.now();
    const timings: Record<string, number> = {};
    const kbs = scopeKbs(this.e, req, projectId);
    const kbById = new Map(kbs.map((k) => [k.id, k]));
    const filter: ChunkFilter = { kb_ids: kbs.map((k) => k.id) };
    if (req.labels?.length) filter.labels = req.labels;
    if (req.media_types?.length) filter.media_types = req.media_types;

    const embedder = this.e.embedder();
    let mode: KbSearchResult["mode"] =
      req.mode === "auto" ? (embedder ? "hybrid" : "lexical") : req.mode;
    let degraded: string | undefined;
    if (mode !== "lexical" && !embedder) {
      degraded = "Semantic search needs an embedding provider; showing keyword results";
      mode = "lexical";
    }

    // chunk id -> fused score
    const fused = new Map<number, number>();
    const matched = new Map<number, Set<"lexical" | "semantic">>();
    const add = (ids: number[], via: "lexical" | "semantic") =>
      ids.forEach((id, rank) => {
        fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
        const m = matched.get(id) ?? new Set();
        m.add(via);
        matched.set(id, m);
      });

    if (mode !== "semantic") {
      const t = performance.now();
      add(
        this.e.idx.lexical(req.query, filter, CANDIDATES).map((h) => h.id),
        "lexical",
      );
      timings.lexical = performance.now() - t;
    }
    if (mode !== "lexical" && embedder) {
      const t = performance.now();
      try {
        const [vector] = await embedder.embed([req.query], "query");
        add(
          this.e.idx.semantic(vector ?? [], embedder.profile, filter, CANDIDATES).map((h) => h.id),
          "semantic",
        );
      } catch (err) {
        degraded = `Semantic search unavailable (${(err as Error).message}); showing keyword results`;
        if (mode === "semantic") {
          mode = "lexical";
          add(
            this.e.idx.lexical(req.query, filter, CANDIDATES).map((h) => h.id),
            "lexical",
          );
        } else mode = "lexical";
      }
      timings.semantic = performance.now() - t;
    }

    // Group chunks by document; a document scores by its best chunk plus a small multi-match bonus.
    const chunks = this.e.idx.getChunks([...fused.keys()]);
    const docIds = [...new Set(chunks.map((c) => c.document_id))];
    const docs = new Map<string, DocRow>();
    if (docIds.length)
      for (const d of this.e.db
        .query(
          `SELECT ${DOC_COLUMNS} FROM kb_documents WHERE id IN (${docIds.map(() => "?").join(",")})`,
        )
        .all(...docIds) as DocRow[])
        docs.set(d.id, d);
    const ranked = new Map<string, Ranked>();
    const sortedChunks = [...chunks].sort(
      (a, b) => (fused.get(b.id) ?? 0) - (fused.get(a.id) ?? 0),
    );
    for (const c of sortedChunks) {
      const doc = docs.get(c.document_id);
      const kb = doc && kbById.get(doc.kb_id);
      // Chunks of an older revision can linger until the reindex lands; never cite them.
      if (!doc || !kb || c.revision !== doc.revision) continue;
      const r = ranked.get(doc.id) ?? { doc, kb, score: 0, matched: new Set(), chunks: [] };
      const s = fused.get(c.id) ?? 0;
      r.score = r.chunks.length ? r.score + s * 0.1 : s;
      for (const m of matched.get(c.id) ?? []) r.matched.add(m);
      r.chunks.push(c.id);
      ranked.set(doc.id, r);
    }

    // Exact title / path / id matches rank first: "open the runbook" should find "Runbook".
    const exact = this.exactMatches(req.query, filter);
    for (const doc of exact) {
      const kb = kbById.get(doc.kb_id);
      if (!kb) continue;
      const r = ranked.get(doc.id) ?? { doc, kb, score: 0, matched: new Set(), chunks: [] };
      r.score += 1;
      r.matched.add("exact");
      ranked.set(doc.id, r);
    }

    const byId = new Map(chunks.map((c) => [c.id, c]));
    const hits: KbSearchHit[] = [...ranked.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, req.limit)
      .map((r) => {
        let passageChunks = r.chunks
          .slice(0, PASSAGES_PER_HIT)
          .map((id) => byId.get(id) as IndexedChunk);
        if (!passageChunks.length)
          passageChunks = this.e.idx
            .documentChunks(r.doc.id)
            .filter((c) => c.revision === r.doc.revision)
            .slice(0, 1);
        return {
          document_id: r.doc.id,
          kb_id: r.kb.id,
          kb_name: r.kb.name,
          title: r.doc.title,
          path: r.doc.path,
          revision: r.doc.revision,
          media_type: r.doc.media_type,
          labels: JSON.parse(r.doc.labels) as string[],
          score: Number(r.score.toFixed(6)),
          matched_by: [...r.matched],
          passages: passageChunks.map((c) => this.passage(c, req.query)),
        };
      });
    timings.total = performance.now() - t0;
    for (const k of Object.keys(timings)) timings[k] = Math.round((timings[k] ?? 0) * 10) / 10;
    return { hits, mode, ...(degraded ? { degraded } : {}), timings_ms: timings };
  }

  private exactMatches(query: string, f: ChunkFilter): DocRow[] {
    if (!f.kb_ids.length) return [];
    const q = query.trim();
    const marks = f.kb_ids.map(() => "?").join(",");
    const rows = this.e.db
      .query(
        `SELECT ${DOC_COLUMNS} FROM kb_documents WHERE kb_id IN (${marks})
         AND (id = ? OR title = ? COLLATE NOCASE OR path = ? COLLATE NOCASE OR path = ? COLLATE NOCASE) LIMIT 5`,
      )
      .all(...f.kb_ids, q, q, q, `${q}.md`) as DocRow[];
    return rows.filter((d) => {
      const labels = JSON.parse(d.labels) as string[];
      if (f.labels?.length && !f.labels.every((l) => labels.includes(l))) return false;
      if (f.media_types?.length && !f.media_types.includes(d.media_type)) return false;
      return true;
    });
  }

  passage(c: IndexedChunk, query: string): KbPassage {
    return {
      chunk_id: c.id,
      citation: citationOf(c),
      heading_path: c.heading_path,
      locator: c.locator,
      text: c.text,
      snippet: snippet(c.text, query),
    };
  }

  /**
   * Compact, cited context for an agent: best passages first, at most max_per_document per
   * document, within an approximate token budget. Derived (agent-written) documents are flagged.
   */
  async evidence(
    raw: KbEvidenceRequest,
    projectId: string | readonly string[] | null | undefined,
  ): Promise<KbEvidencePack> {
    const req = KbEvidenceSchema.parse(raw);
    const result = await this.search(
      {
        query: req.query,
        scope: req.scope,
        ...(req.kb_ids ? { kb_ids: req.kb_ids } : {}),
        ...(req.labels ? { labels: req.labels } : {}),
        ...(req.media_types ? { media_types: req.media_types } : {}),
        mode: req.mode,
        limit: 50,
      },
      projectId,
    );
    const items: KbEvidencePack["items"] = [];
    const omitted: KbEvidencePack["omitted"] = [];
    let tokens = 0;
    const derived = new Map<string, boolean>();
    for (const hit of result.hits) {
      if (!derived.has(hit.document_id)) {
        const d = this.e.catalog.doc(hit.document_id);
        derived.set(hit.document_id, !!d && (JSON.parse(d.derived_from) as string[]).length > 0);
      }
      let used = 0;
      for (const p of hit.passages.slice(0, req.max_per_document)) {
        const cost = estimateTokens(p.text) + 30;
        if (tokens + cost > req.token_budget) break;
        tokens += cost;
        used++;
        items.push({
          ...p,
          document_id: hit.document_id,
          kb_name: hit.kb_name,
          title: hit.title,
          revision: hit.revision,
          derived: derived.get(hit.document_id) ?? false,
        });
      }
      if (!used) omitted.push({ document_id: hit.document_id, title: hit.title });
    }
    const pack: KbEvidencePack = {
      query: req.query,
      mode: result.mode,
      token_estimate: tokens,
      items,
      omitted,
    };
    if (result.degraded) pack.degraded = result.degraded;
    if (!items.length)
      pack.note = "No matching knowledge. Do not invent an answer from this knowledge base.";
    else if (items.some((i) => i.derived))
      pack.note =
        "Items marked derived were written by agents from other sources; prefer primary documents.";
    return pack;
  }
}
