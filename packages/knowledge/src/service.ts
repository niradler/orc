import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, sep } from "node:path";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import {
  type KbCallContext,
  type KbCreate,
  KbCreateSchema,
  type KbDoclingState,
  type KbDocument,
  type KbDocumentCreate,
  KbDocumentCreateSchema,
  type KbDocumentListing,
  type KbDocumentUpdate,
  KbDocumentUpdateSchema,
  type KbDocumentWithContent,
  type KbEvidencePack,
  type KbEvidenceRequest,
  type KbMaintenanceQueue,
  type KbRevision,
  type KbScope,
  type KbSearchRequest,
  type KbSearchResult,
  type KbSource,
  type KbSourceScan,
  type KbStatus,
  type KbUpdate,
  KbUpdateSchema,
  type KbUsageStats,
  type KnowledgeBase,
} from "@orc/core/kb";
import { PathValidationError, validateCollectionPath } from "@orc/core/validate";
import {
  Catalog,
  DOC_COLUMNS,
  type DocRow,
  isEditable,
  type KbRow,
  type RevisionRow,
  type SourceRow,
  toDoc,
  toKb,
  toRevision,
} from "./catalog.js";
import { decodeUtf8, documentText, externalFile, isMarkdownName, sourceOf } from "./content.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import type { Engine, KnowledgeConfig } from "./engine.js";
import { IndexDb } from "./index-db.js";
import { JobRunner } from "./jobs.js";
import { resolveKbLinks } from "./links.js";
import { firstHeading, type markdownToBlocks, outline, stripFrontmatter } from "./markdown.js";
import { BASIC_FORMATS } from "./parsers/basic.js";
import {
  DOCLING_FORMATS,
  installDocling,
  readDoclingManifest,
  uninstallDocling,
} from "./parsers/docling.js";
import { listParsers, PARSER_IDS } from "./parsers/registry.js";
import { Searcher, scopeKbs } from "./search.js";
import { KnowledgeStorage } from "./storage.js";
import { Usage, type UsageTarget } from "./usage.js";

const MAINTENANCE_INTERVAL_MS = 60_000;
const MAX_SOURCE_FILES = 5000;
const SOURCE_MISSING = "Source file is missing";
const SCANNER = "folder scan";
export const DEFAULT_SOURCE_PATTERN = "**/*.{md,markdown,txt,pdf,docx,pptx,xlsx,csv,html,htm}";

const MEDIA_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  webp: "image/webp",
};
export const KB_UPLOAD_FORMATS = [...new Set([...BASIC_FORMATS, ...DOCLING_FORMATS])];
export const mediaTypeOf = (name: string) =>
  MEDIA_TYPES[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";

export const sha256 = KnowledgeStorage.sha256;

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80);
  return slug || "untitled";
}

const actorName = (ctx: KbCallContext) => ctx.actor.name ?? ctx.actor.backend ?? ctx.source;

export type DocumentReadOptions = {
  /** Return only one chunk (from a citation) or one heading's section instead of everything. */
  ordinal?: number;
  heading?: string;
  /** false for UI refreshes that should not count as a read. */
  record?: boolean;
};

const UploadMetaSchema = KbDocumentUpdateSchema.pick({
  title: true,
  path: true,
  description: true,
  labels: true,
  note: true,
});

export type UploadInput = {
  name: string;
  bytes: Uint8Array;
  title?: string | undefined;
  path?: string | undefined;
  labels?: string[] | undefined;
  description?: string | undefined;
  /** Replace the original of an existing upload; requires expected_revision. */
  document_id?: string;
  expected_revision?: number;
  note?: string | undefined;
};

export type KnowledgeServiceOptions = {
  db: Database;
  config: () => KnowledgeConfig;
  /** Overrides config().root (tests). */
  root?: string;
  /** Overrides the provider built from config (tests). */
  embedder?: EmbeddingProvider | null;
};

/**
 * Single knowledge-base service. REST, MCP, CLI and the web UI are transports over it; each call
 * carries a KbCallContext (actor + transport) used for authorization and read accounting.
 */
export class KnowledgeService {
  readonly engine: Engine;
  readonly jobs: JobRunner;
  readonly searcher: Searcher;
  readonly usage: Usage;
  readonly docling: KbDoclingState = { state: "idle", log: [] };
  private maintenance: ReturnType<typeof setInterval> | null = null;
  private embedderCache: { key: string; provider: EmbeddingProvider | null } | null = null;

  private constructor(
    readonly db: Database,
    idx: IndexDb,
    storage: KnowledgeStorage,
    private readonly cfg: () => KnowledgeConfig,
    embedderOverride: EmbeddingProvider | null | undefined,
  ) {
    const embedder =
      embedderOverride !== undefined
        ? () => embedderOverride
        : () => {
            const key = JSON.stringify(this.cfg().embedding);
            if (this.embedderCache?.key !== key)
              this.embedderCache = { key, provider: createEmbeddingProvider(this.cfg().embedding) };
            return this.embedderCache.provider;
          };
    this.engine = {
      db,
      catalog: new Catalog(db),
      idx,
      storage,
      config: cfg,
      embedder,
      kick: () => this.jobs.kick(),
    };
    this.jobs = new JobRunner(this.engine);
    this.searcher = new Searcher(this.engine);
    this.usage = new Usage(db);
  }

  static async open(opts: KnowledgeServiceOptions): Promise<KnowledgeService> {
    const root = opts.root ?? opts.config().root;
    if (!root) throw new Error("Knowledge root is not configured");
    const storage = new KnowledgeStorage(root);
    const idx = await IndexDb.open(storage.indexPath);
    return new KnowledgeService(opts.db, idx, storage, opts.config, opts.embedder);
  }

  /** Recover interrupted work, repair derived state, then process jobs in the background. */
  start(opts: { maintenance?: boolean } = {}) {
    this.reconcile();
    this.jobs.start();
    // Folder rescans and pruning belong to one long-lived process (the daemon); other processes
    // (stdio MCP) only process the jobs they enqueue.
    if (opts.maintenance !== false && !this.maintenance) {
      this.maintenance = setInterval(() => this.maintain(), MAINTENANCE_INTERVAL_MS);
      this.maintenance.unref?.();
    }
  }

  async stop() {
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = null;
    await this.jobs.stop();
  }

  close() {
    this.engine.idx.close();
  }

  private get catalog() {
    return this.engine.catalog;
  }

  // --- Authorization -------------------------------------------------------------------------

  /**
   * Managing KBs themselves (create, settings, delete, folders, parsers) is not offered over MCP:
   * otherwise an agent could widen its own `editable_by`.
   */
  private requireManager(ctx: KbCallContext, what: string) {
    if (ctx.source === "mcp") throw new ForbiddenError(`Cannot ${what} over MCP`);
  }

  /** Document changes are allowed only from the call sources listed in the KB's `editable_by`. */
  private requireEditable(ctx: KbCallContext, kb: KbRow) {
    if (!toKb(kb).editable_by.includes(ctx.source))
      throw new ForbiddenError(
        `Knowledge base "${kb.name}" cannot be edited from ${ctx.source}; allowed: ${toKb(kb).editable_by.join(", ") || "none"}`,
      );
  }

  private kbOrThrow(id: string): KbRow {
    const kb = this.catalog.kb(id);
    if (!kb) throw new NotFoundError("Knowledge base", id);
    return kb;
  }

  private docOrThrow(id: string): DocRow {
    const doc = this.catalog.doc(id);
    if (!doc) throw new NotFoundError("Document", id);
    return doc;
  }

  // --- Knowledge bases -----------------------------------------------------------------------

  listKbs(ctx: KbCallContext, scope: KbScope = "default"): KnowledgeBase[] {
    const rows = scopeKbs(this.engine, { scope }, ctx.project_id);
    const counts = new Map(
      (
        this.db.query("SELECT kb_id, count(*) AS n FROM kb_documents GROUP BY kb_id").all() as {
          kb_id: string;
          n: number;
        }[]
      ).map((r) => [r.kb_id, r.n]),
    );
    return rows
      .map((r) => toKb({ ...r, document_count: counts.get(r.id) ?? 0 }))
      .sort(
        (a, b) =>
          Number(a.project_id === null) - Number(b.project_id === null) ||
          a.name.localeCompare(b.name),
      );
  }

  getKb(id: string): KnowledgeBase {
    return toKb(this.kbOrThrow(id));
  }

  createKb(ctx: KbCallContext, raw: KbCreate): KnowledgeBase {
    this.requireManager(ctx, "create knowledge bases");
    const input = KbCreateSchema.parse(raw);
    if (input.project_id && !this.catalog.projectExists(input.project_id))
      throw new NotFoundError("Project", input.project_id);
    if (
      input.parser &&
      input.parser !== "auto" &&
      !(PARSER_IDS as readonly string[]).includes(input.parser)
    )
      throw new ValidationError(`Unknown parser: ${input.parser}`);
    this.assertNameFree(input.name, input.project_id);
    const id = ulid();
    const now = Date.now();
    this.db.run(
      `INSERT INTO knowledge_bases (id, name, description, project_id, editable_by, parser, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name,
        input.description,
        input.project_id,
        JSON.stringify(input.editable_by),
        input.parser,
        now,
        now,
      ],
    );
    return this.getKb(id);
  }

  private assertNameFree(name: string, projectId: string | null, exceptId?: string) {
    const clash = this.db
      .query(
        "SELECT id FROM knowledge_bases WHERE coalesce(project_id, '') = ? AND name = ? COLLATE NOCASE AND id != ?",
      )
      .get(projectId ?? "", name, exceptId ?? "");
    if (clash)
      throw new ConflictError(`A knowledge base named "${name}" already exists in this scope`);
  }

  updateKb(ctx: KbCallContext, id: string, raw: KbUpdate): KnowledgeBase {
    this.requireManager(ctx, "change knowledge base settings");
    const input = KbUpdateSchema.parse(raw);
    const kb = this.kbOrThrow(id);
    if (input.name !== undefined) this.assertNameFree(input.name, kb.project_id, id);
    if (
      input.parser &&
      input.parser !== "auto" &&
      !(PARSER_IDS as readonly string[]).includes(input.parser)
    )
      throw new ValidationError(`Unknown parser: ${input.parser}`);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };
    if (input.name !== undefined) set("name", input.name);
    if (input.description !== undefined) set("description", input.description);
    if (input.editable_by !== undefined) set("editable_by", JSON.stringify(input.editable_by));
    if (input.parser !== undefined) set("parser", input.parser);
    if (sets.length) {
      set("updated_at", Date.now());
      this.db.run(`UPDATE knowledge_bases SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
    }
    return this.getKb(id);
  }

  /** Deletes the KB, its documents, revisions and stored files. Registered folders are untouched. */
  deleteKb(ctx: KbCallContext, id: string) {
    this.requireManager(ctx, "delete knowledge bases");
    this.kbOrThrow(id);
    const docIds = (
      this.db.query("SELECT id FROM kb_documents WHERE kb_id = ?").all(id) as { id: string }[]
    ).map((r) => r.id);
    this.db.transaction(() => {
      this.db.run("DELETE FROM kb_jobs WHERE kb_id = ?", [id]);
      this.db.run("DELETE FROM kb_links WHERE kb_id = ?", [id]);
      this.db.run("DELETE FROM knowledge_bases WHERE id = ?", [id]);
    })();
    this.usage.forgetKb(id);
    this.engine.idx.deleteKb(id);
    this.engine.storage.removeKb(id, docIds);
  }

  // --- Documents: reads ----------------------------------------------------------------------

  listDocuments(kbId: string, filter: { folder?: string; label?: string } = {}): KbDocumentListing {
    this.kbOrThrow(kbId);
    const rows = this.db
      .query(`SELECT ${DOC_COLUMNS} FROM kb_documents WHERE kb_id = ? ORDER BY path COLLATE NOCASE`)
      .all(kbId) as DocRow[];
    const folders = new Set<string>();
    const labels = new Map<string, number>();
    for (const r of rows) {
      const parts = r.path.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
      for (const l of JSON.parse(r.labels) as string[]) labels.set(l, (labels.get(l) ?? 0) + 1);
    }
    const reads = this.usage.documentReads(kbId);
    const folder = filter.folder?.replace(/\/+$/, "");
    const documents = rows
      .filter((r) => !folder || r.path.toLowerCase().startsWith(`${folder.toLowerCase()}/`))
      .filter((r) => !filter.label || (JSON.parse(r.labels) as string[]).includes(filter.label))
      .map((r) => {
        const u = reads.get(r.id);
        return { ...toDoc(r), reads: u?.reads ?? 0, reads_by_source: u?.by_source ?? {} };
      });
    return {
      documents,
      folders: [...folders].sort((a, b) => a.localeCompare(b)),
      labels: [...labels]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
  }

  getDocument(
    ctx: KbCallContext,
    id: string,
    opts: DocumentReadOptions = {},
  ): KbDocumentWithContent {
    const doc = this.docOrThrow(id);
    const text = documentText(this.engine, doc);
    let content = text?.markdown ?? "";
    const blocks = text?.blocks ?? [];
    if (opts.ordinal !== undefined) {
      const chunk = this.engine.idx.documentChunks(id).find((c) => c.ordinal === opts.ordinal);
      if (!chunk || chunk.revision !== doc.revision)
        throw new NotFoundError("Passage", `kb:${id}@${doc.revision}#${opts.ordinal}`);
      content = chunk.text;
    } else if (opts.heading) {
      content = sectionOf(blocks, opts.heading) ?? "";
      if (!content) throw new NotFoundError("Section", opts.heading);
    }
    const links = this.db
      .query(
        `SELECT l.target, l.to_id AS document_id, d.title FROM kb_links l LEFT JOIN kb_documents d ON d.id = l.to_id
         WHERE l.from_id = ? ORDER BY coalesce(d.title, l.target)`,
      )
      .all(id) as KbDocumentWithContent["links"];
    const backlinks = this.db
      .query(
        `SELECT DISTINCT d.id AS document_id, d.title, d.kb_id FROM kb_links l JOIN kb_documents d ON d.id = l.from_id
         WHERE l.to_id = ? AND l.from_id != ? ORDER BY d.title`,
      )
      .all(id, id) as KbDocumentWithContent["backlinks"];
    if (opts.record !== false) this.usage.record(ctx, "fetch", [target(doc)]);
    return {
      ...toDoc(doc),
      content,
      outline: outline(blocks),
      backlinks,
      links,
    };
  }

  /** Resolves a citation handle (kb:<doc>@<rev>#<n>) to its passage; stale revisions are refused. */
  readCitation(ctx: KbCallContext, documentId: string, revision: number, ordinal: number) {
    const doc = this.docOrThrow(documentId);
    if (doc.revision !== revision)
      throw new ConflictError(
        `Citation is for revision ${revision}; the document is now at revision ${doc.revision}. Search again.`,
      );
    return this.getDocument(ctx, documentId, { ordinal });
  }

  revisions(documentId: string): KbRevision[] {
    this.docOrThrow(documentId);
    return (
      this.db
        .query("SELECT * FROM kb_document_revisions WHERE document_id = ? ORDER BY revision DESC")
        .all(documentId) as RevisionRow[]
    ).map(toRevision);
  }

  revisionContent(documentId: string, revision: number): KbRevision & { content: string | null } {
    const row = this.catalog.revision(documentId, revision);
    if (!row) throw new NotFoundError("Revision", `${documentId}@${revision}`);
    return { ...toRevision(row), content: row.content };
  }

  /** Original bytes of an upload or folder copy (current or a past revision) for download. */
  original(ctx: KbCallContext, documentId: string, revision?: number) {
    const doc = this.docOrThrow(documentId);
    const rev = this.catalog.revision(documentId, revision ?? doc.revision);
    if (doc.origin === "authored" || !rev?.original_rel)
      throw new NotFoundError("Original file", documentId);
    this.usage.record(ctx, "fetch", [target(doc)]);
    return {
      path: this.engine.storage.resolveRel(rev.original_rel),
      name: doc.original_name ?? doc.path.split("/").pop() ?? "document",
      media_type: doc.media_type,
    };
  }

  // --- Documents: writes ---------------------------------------------------------------------

  private freePath(kbId: string, wanted: string, exceptId?: string): string {
    const taken = (p: string) => {
      const d = this.catalog.docByPath(kbId, p);
      return !!d && d.id !== exceptId;
    };
    if (!taken(wanted)) return wanted;
    const dot = wanted.lastIndexOf(".");
    const [stem, ext] =
      dot > wanted.lastIndexOf("/") ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ""];
    for (let n = 2; n < 1000; n++) if (!taken(`${stem}-${n}${ext}`)) return `${stem}-${n}${ext}`;
    throw new ConflictError(`No free path near ${wanted}`);
  }

  private assertPathFree(kbId: string, path: string, exceptId?: string) {
    const d = this.catalog.docByPath(kbId, path);
    if (d && d.id !== exceptId) throw new ConflictError(`A document already exists at ${path}`);
  }

  private insertRevision(
    doc: DocRow,
    ctx: KbCallContext,
    note: string,
    originalRel: string | null,
  ) {
    this.db.run(
      `INSERT INTO kb_document_revisions (document_id, revision, title, path, labels, content, content_hash, original_rel, note, actor, source, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        doc.id,
        doc.revision,
        doc.title,
        doc.path,
        doc.labels,
        doc.content,
        doc.content_hash,
        originalRel,
        note,
        actorName(ctx),
        ctx.source,
        ctx.actor.session_id ?? null,
        doc.updated_at,
      ],
    );
  }

  private insertDocument(doc: DocRow) {
    const cols = DOC_COLUMNS.split(",").map((c) => c.trim());
    this.db.run(
      `INSERT INTO kb_documents (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      cols.map((c) => doc[c as keyof DocRow]),
    );
  }

  /** Documents derived from a changed source are flagged so maintainers refresh them. */
  private markDependentsStale(sourceId: string) {
    this.db.run(
      "UPDATE kb_documents SET stale = 1 WHERE id != ? AND EXISTS (SELECT 1 FROM json_each(kb_documents.derived_from) WHERE value = ?)",
      [sourceId, sourceId],
    );
  }

  createDocument(
    ctx: KbCallContext,
    kbId: string,
    raw: KbDocumentCreate,
    note?: string,
  ): KbDocument {
    const kb = this.kbOrThrow(kbId);
    this.requireEditable(ctx, kb);
    const input = KbDocumentCreateSchema.parse(raw);
    const path = input.path ?? this.freePath(kbId, `${slugify(input.title)}.md`);
    if (input.path) this.assertPathFree(kbId, path);
    if (!isMarkdownName(path)) throw new ValidationError("Authored documents need a .md path");
    const now = Date.now();
    const doc: DocRow = {
      id: ulid(),
      kb_id: kbId,
      title: input.title,
      description: input.description ?? "",
      path,
      labels: JSON.stringify(normalizeLabels(input.labels)),
      origin: "authored",
      media_type: "text/markdown",
      original_name: null,
      size_bytes: Buffer.byteLength(input.content),
      content_hash: sha256(input.content),
      revision: 1,
      content: input.content,
      source_id: null,
      external_path: null,
      folder_detached: 0,
      parse_state: "ok",
      index_state: "pending",
      parser_id: null,
      parser_version: null,
      parser_options_hash: null,
      warnings: "[]",
      derived_from: JSON.stringify(this.validDerivedFrom(input.derived_from)),
      stale: 0,
      created_at: now,
      updated_at: now,
      updated_by: actorName(ctx),
    };
    this.db.transaction(() => {
      this.insertDocument(doc);
      this.insertRevision(doc, ctx, note ?? input.note ?? "Created", null);
      this.catalog.enqueue(kbId, doc.id, 1, "index", ulid());
    })();
    this.afterWrite(doc);
    return toDoc(doc);
  }

  private validDerivedFrom(ids: string[]): string[] {
    if (!ids.length) return [];
    const found = new Set(
      (
        this.db
          .query(`SELECT id FROM kb_documents WHERE id IN (${ids.map(() => "?").join(",")})`)
          .all(...ids) as { id: string }[]
      ).map((r) => r.id),
    );
    const missing = ids.filter((i) => !found.has(i));
    if (missing.length)
      throw new ValidationError(`derived_from references unknown documents: ${missing.join(", ")}`);
    return [...new Set(ids)];
  }

  private afterWrite(doc: DocRow) {
    if (doc.content !== null) this.engine.storage.putProjection(doc.kb_id, doc.id, doc.content);
    resolveKbLinks(this.db, doc.kb_id);
    this.engine.kick();
  }

  updateDocument(
    ctx: KbCallContext,
    id: string,
    raw: KbDocumentUpdate,
    extra: { note?: string } = {},
  ): KbDocument {
    const input = KbDocumentUpdateSchema.parse(raw);
    const cur = this.docOrThrow(id);
    const kb = this.kbOrThrow(cur.kb_id);
    this.requireEditable(ctx, kb);
    if (input.expected_revision !== cur.revision)
      throw new ConflictError(
        `Document changed: you edited revision ${input.expected_revision}, current is ${cur.revision}. Reload and reapply.`,
      );
    const next: DocRow = { ...cur };
    let contentChanged = false;
    if (input.content !== undefined && input.content !== (cur.content ?? null)) {
      if (!isEditable(cur))
        throw new ValidationError(
          "This document's content comes from a file; replace the file instead",
        );
      next.content = input.content;
      // The folder file is never written: an edited copy stops following it.
      if (cur.origin === "external") next.folder_detached = 1;
      next.content_hash = sha256(input.content);
      next.size_bytes = Buffer.byteLength(input.content);
      contentChanged = next.content_hash !== cur.content_hash;
    }
    if (input.path !== undefined && input.path !== cur.path) {
      if (isEditable(cur) && !isMarkdownName(input.path))
        throw new ValidationError("Authored documents need a .md path");
      this.assertPathFree(cur.kb_id, input.path, id);
      next.path = input.path;
    }
    if (input.title !== undefined) next.title = input.title;
    if (input.description !== undefined) next.description = input.description;
    if (input.labels !== undefined) next.labels = JSON.stringify(normalizeLabels(input.labels));
    if (input.derived_from !== undefined)
      next.derived_from = JSON.stringify(
        this.validDerivedFrom(input.derived_from.filter((d) => d !== id)),
      );
    const changed =
      contentChanged ||
      (["title", "description", "path", "labels", "derived_from"] as const).some(
        (k) => next[k] !== cur[k],
      );
    if (!changed) return toDoc(cur);
    next.revision = cur.revision + 1;
    next.updated_at = Date.now();
    next.updated_by = actorName(ctx);
    next.index_state = "pending";
    // A content update by the maintainer refreshes the derived document.
    if (contentChanged || input.derived_from !== undefined) next.stale = 0;
    // Detaching is a content change, so it is recorded with the revision below.
    const prevRev = this.catalog.revision(id, cur.revision);
    this.db.transaction(() => {
      const res = this.db.run(
        `UPDATE kb_documents SET title = ?, description = ?, path = ?, labels = ?, content = ?, content_hash = ?,
           size_bytes = ?, revision = ?, index_state = ?, derived_from = ?, stale = ?, folder_detached = ?, updated_at = ?, updated_by = ?
         WHERE id = ? AND revision = ?`,
        [
          next.title,
          next.description,
          next.path,
          next.labels,
          next.content,
          next.content_hash,
          next.size_bytes,
          next.revision,
          next.index_state,
          next.derived_from,
          next.stale,
          next.folder_detached,
          next.updated_at,
          next.updated_by,
          id,
          cur.revision,
        ],
      );
      if (!res.changes)
        throw new ConflictError("Document changed concurrently. Reload and reapply.");
      this.insertRevision(next, ctx, extra.note ?? input.note ?? "", prevRev?.original_rel ?? null);
      // Metadata-only changes reuse the parsed artifact (keyed by content hash), so index only.
      this.catalog.enqueue(cur.kb_id, id, next.revision, "index", ulid());
      if (contentChanged) this.markDependentsStale(id);
    })();
    this.afterWrite(next);
    return toDoc(next);
  }

  deleteDocument(ctx: KbCallContext, id: string) {
    const doc = this.docOrThrow(id);
    this.requireEditable(ctx, this.kbOrThrow(doc.kb_id));
    if (doc.origin === "external")
      throw new ValidationError(
        "This document is a copy from a registered folder; remove the folder from the knowledge base instead",
      );
    this.removeDocumentRecord(doc);
  }

  private removeDocumentRecord(doc: DocRow, relink = true) {
    this.db.transaction(() => {
      this.db.run("DELETE FROM kb_jobs WHERE document_id = ?", [doc.id]);
      this.db.run("DELETE FROM kb_documents WHERE id = ?", [doc.id]);
    })();
    this.usage.forgetDocument(doc.id);
    this.engine.idx.deleteDocument(doc.id);
    this.engine.storage.removeDocument(doc.kb_id, doc.id);
    if (relink) resolveKbLinks(this.db, doc.kb_id);
  }

  /**
   * Intake for a file. Markdown/text becomes an authored (editable) document; other formats keep
   * their immutable original and are parsed in the background.
   */
  upload(ctx: KbCallContext, kbId: string, raw: UploadInput): KbDocument {
    const kb = this.kbOrThrow(kbId);
    this.requireEditable(ctx, kb);
    // Same bounds as typed documents for the metadata that arrives beside the file.
    const meta = UploadMetaSchema.parse({
      title: raw.title,
      path: raw.path,
      description: raw.description,
      labels: raw.labels,
      note: raw.note,
    });
    const input: UploadInput = { ...raw, ...meta };
    // Only the base name, without characters that are invalid in a KB path.
    const name =
      input.name
        .split(/[\\/]/)
        .pop()
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
        ?.replace(/[:\u0000-\u001f]/g, "-")
        .trim() ?? "";
    const ext = extname(name).slice(1).toLowerCase();
    if (!name || !ext) throw new ValidationError("File name needs an extension");
    if (!KB_UPLOAD_FORMATS.includes(ext))
      throw new ValidationError(
        `.${ext} files are not supported. Supported: ${KB_UPLOAD_FORMATS.join(", ")}`,
      );
    const limit = this.cfg().max_upload_bytes;
    if (input.bytes.byteLength > limit)
      throw new ValidationError(
        `File is larger than the ${Math.round(limit / 1048576)} MB upload limit`,
      );
    if (!input.bytes.byteLength) throw new ValidationError("File is empty");
    const labels = normalizeLabels(input.labels ?? []);

    if (ext === "md" || ext === "markdown" || ext === "txt") {
      const text = decodeUtf8(input.bytes);
      if (text === null) throw new ValidationError("Text files must be UTF-8");
      const stem = name.replace(/\.[^.]+$/, "");
      const content = text;
      if (input.document_id) {
        const cur = this.docOrThrow(input.document_id);
        return this.updateDocument(ctx, cur.id, {
          expected_revision: input.expected_revision ?? 0,
          content,
          ...(input.title ? { title: input.title } : {}),
          ...(input.labels ? { labels } : {}),
          note: input.note ?? `Replaced from ${name}`,
        });
      }
      const path = input.path ?? this.freePath(kbId, `${ext === "txt" ? slugify(stem) : stem}.md`);
      return this.createDocument(
        ctx,
        kbId,
        {
          title: input.title ?? firstHeading(stripFrontmatter(text)) ?? stem,
          path,
          labels,
          content,
          ...(input.description ? { description: input.description } : {}),
        },
        input.note ?? `Uploaded ${name}`,
      );
    }

    const hash = sha256(input.bytes);
    const now = Date.now();
    if (input.document_id) {
      const cur = this.docOrThrow(input.document_id);
      if (cur.kb_id !== kbId || cur.origin !== "upload")
        throw new ValidationError("Only uploaded files can be replaced");
      if (input.expected_revision !== cur.revision)
        throw new ConflictError(
          `Document is at revision ${cur.revision}; reload before replacing the file`,
        );
      if (cur.content_hash === hash) return toDoc(cur);
      const revision = cur.revision + 1;
      const rel = this.engine.storage.putOriginal(kbId, cur.id, revision, ext, input.bytes);
      const next: DocRow = {
        ...cur,
        revision,
        content_hash: hash,
        size_bytes: input.bytes.byteLength,
        original_name: name,
        media_type: mediaTypeOf(name),
        title: input.title ?? cur.title,
        labels: input.labels ? JSON.stringify(labels) : cur.labels,
        parse_state: "pending",
        index_state: "pending",
        warnings: "[]",
        updated_at: now,
        updated_by: actorName(ctx),
      };
      this.db.transaction(() => {
        const res = this.db.run(
          `UPDATE kb_documents SET revision = ?, content_hash = ?, size_bytes = ?, original_name = ?, media_type = ?,
             title = ?, labels = ?, parse_state = 'pending', index_state = 'pending', warnings = '[]', updated_at = ?, updated_by = ?
           WHERE id = ? AND revision = ?`,
          [
            revision,
            hash,
            next.size_bytes,
            name,
            next.media_type,
            next.title,
            next.labels,
            now,
            next.updated_by,
            cur.id,
            cur.revision,
          ],
        );
        if (!res.changes)
          throw new ConflictError("Document changed concurrently. Reload and retry.");
        this.insertRevision(next, ctx, input.note ?? `Replaced with ${name}`, rel);
        this.catalog.enqueue(kbId, cur.id, revision, "parse", ulid());
        this.markDependentsStale(cur.id);
      })();
      this.afterWrite(next);
      return toDoc(next);
    }

    const id = ulid();
    const path = input.path ?? this.freePath(kbId, name);
    if (input.path) this.assertPathFree(kbId, path);
    // Immutable bytes are published before the catalog references them.
    const rel = this.engine.storage.putOriginal(kbId, id, 1, ext, input.bytes);
    const doc: DocRow = {
      id,
      kb_id: kbId,
      title: input.title ?? name.replace(/\.[^.]+$/, ""),
      description: input.description ?? "",
      path,
      labels: JSON.stringify(labels),
      origin: "upload",
      media_type: mediaTypeOf(name),
      original_name: name,
      size_bytes: input.bytes.byteLength,
      content_hash: hash,
      revision: 1,
      content: null,
      source_id: null,
      external_path: null,
      folder_detached: 0,
      parse_state: "pending",
      index_state: "pending",
      parser_id: null,
      parser_version: null,
      parser_options_hash: null,
      warnings: "[]",
      derived_from: "[]",
      stale: 0,
      created_at: now,
      updated_at: now,
      updated_by: actorName(ctx),
    };
    this.db.transaction(() => {
      this.insertDocument(doc);
      this.insertRevision(doc, ctx, input.note ?? `Uploaded ${name}`, rel);
      this.catalog.enqueue(kbId, id, 1, "parse", ulid());
    })();
    this.afterWrite(doc);
    return toDoc(doc);
  }

  /** Re-extracts a file with the currently selected parser (after installing Docling, say). */
  reparse(ctx: KbCallContext, id: string): KbDocument {
    const doc = this.docOrThrow(id);
    this.requireEditable(ctx, this.kbOrThrow(doc.kb_id));
    if (
      doc.origin === "authored" ||
      (doc.origin === "external" && doc.media_type === "text/markdown")
    ) {
      this.catalog.enqueue(doc.kb_id, id, doc.revision, "index", ulid());
    } else {
      this.db.run(
        "UPDATE kb_documents SET parse_state = 'pending', index_state = 'pending', warnings = '[]' WHERE id = ?",
        [id],
      );
      this.catalog.enqueue(doc.kb_id, id, doc.revision, "parse", ulid());
    }
    this.engine.kick();
    return toDoc(this.docOrThrow(id));
  }

  // --- Search --------------------------------------------------------------------------------

  async search(ctx: KbCallContext, req: KbSearchRequest): Promise<KbSearchResult> {
    const result = await this.searcher.search(req, ctx.project_id);
    this.usage.record(
      ctx,
      "search_hit",
      result.hits.map((h) => ({
        document_id: h.document_id,
        kb_id: h.kb_id,
        revision: h.revision,
      })),
    );
    return result;
  }

  async evidence(ctx: KbCallContext, req: KbEvidenceRequest): Promise<KbEvidencePack> {
    const pack = await this.searcher.evidence(req, ctx.project_id);
    const kbOf = new Map<string, string>();
    for (const i of pack.items)
      if (!kbOf.has(i.document_id))
        kbOf.set(i.document_id, this.catalog.doc(i.document_id)?.kb_id ?? "");
    this.usage.record(
      ctx,
      "cited",
      pack.items.map((i) => ({
        document_id: i.document_id,
        kb_id: kbOf.get(i.document_id) ?? "",
        revision: i.revision,
      })),
    );
    return pack;
  }

  // --- Usage ---------------------------------------------------------------------------------

  documentUsage(id: string): KbUsageStats {
    this.docOrThrow(id);
    return this.usage.stats({ document_id: id });
  }

  kbUsage(id: string): KbUsageStats {
    this.kbOrThrow(id);
    return this.usage.stats({ kb_id: id });
  }

  // --- Status, parsers, maintenance ----------------------------------------------------------

  status(): KbStatus {
    const count = (sql: string) => (this.db.query(sql).get() as { n: number }).n;
    const jobs = this.db
      .query("SELECT status, count(*) AS n FROM kb_jobs GROUP BY status")
      .all() as {
      status: string;
      n: number;
    }[];
    const job = (s: string) => jobs.find((j) => j.status === s)?.n ?? 0;
    const cfg = this.cfg();
    const embedder = this.engine.embedder();
    const pending = embedder ? this.engine.idx.pendingEmbeddingCount(embedder.profile) : 0;
    const embedding: KbStatus["embedding"] = {
      provider: cfg.embedding.provider,
      model: embedder?.model ?? null,
      dimensions:
        cfg.embedding.dimensions ??
        (embedder ? this.engine.idx.vectorDimensions(embedder.profile) : null),
      vector_backend: embedder ? this.engine.idx.backend : null,
      ready: !!embedder && pending === 0,
      pending_chunks: pending,
    };
    const failedEmbed = this.db
      .query(
        "SELECT error FROM kb_jobs WHERE kind = 'embed' AND status = 'failed' ORDER BY updated_at DESC LIMIT 1",
      )
      .get() as { error: string | null } | null;
    const detail = [
      failedEmbed?.error ? `Last embedding error: ${failedEmbed.error}` : "",
      this.engine.idx.backendDetail && embedder && this.engine.idx.backend === "exact-scan"
        ? this.engine.idx.backendDetail
        : "",
    ]
      .filter(Boolean)
      .join("; ");
    if (detail) embedding.detail = detail;
    return {
      root: this.engine.storage.root,
      knowledge_bases: count("SELECT count(*) AS n FROM knowledge_bases"),
      documents: count("SELECT count(*) AS n FROM kb_documents"),
      chunks: this.engine.idx.chunkCount(),
      jobs: { queued: job("queued"), running: job("running"), failed: job("failed") },
      embedding,
      parsers: this.parsers(),
    };
  }

  parsers() {
    const list = listParsers(this.engine.storage.root, this.cfg());
    const docling = list.find((p) => p.id === "docling");
    if (docling && this.docling.state !== "idle")
      docling.detail =
        this.docling.state === "installing"
          ? `Installing: ${this.docling.step ?? ""}`
          : (this.docling.error ?? "Install failed");
    return list;
  }

  /** Starts the optional Docling install in the background; progress is in `docling`. */
  installDocling(ctx: KbCallContext) {
    this.requireManager(ctx, "install parsers");
    if (this.docling.state === "installing") return this.docling;
    Object.assign(this.docling, {
      state: "installing",
      log: [],
      error: undefined,
      step: "Starting",
      started_at: Date.now(),
    });
    installDocling(this.engine.storage.root, this.docling)
      .then(() => {
        this.docling.state = "idle";
        this.requeueParserFailures();
      })
      .catch((err: Error) => {
        this.docling.state = "failed";
        this.docling.error = err.message.slice(0, 1000);
      });
    return this.docling;
  }

  uninstallDocling(ctx: KbCallContext) {
    this.requireManager(ctx, "remove parsers");
    if (this.docling.state === "installing") throw new ConflictError("Docling is being installed");
    uninstallDocling(this.engine.storage.root);
    Object.assign(this.docling, { state: "idle", log: [], error: undefined, step: undefined });
  }

  /** After a parser becomes available, files that failed only for lack of it are retried. */
  private requeueParserFailures() {
    if (!readDoclingManifest(this.engine.storage.root)) return;
    const rows = this.db
      .query(
        `SELECT d.id, d.kb_id, d.revision FROM kb_documents d JOIN kb_jobs j
           ON j.document_id = d.id AND j.revision = d.revision AND j.kind = 'parse' AND j.status = 'failed'
         WHERE j.error LIKE '%Docling%'`,
      )
      .all() as { id: string; kb_id: string; revision: number }[];
    for (const r of rows) {
      this.db.run(
        "UPDATE kb_documents SET parse_state = 'pending', index_state = 'pending', warnings = '[]' WHERE id = ?",
        [r.id],
      );
      this.catalog.enqueue(r.kb_id, r.id, r.revision, "parse", ulid());
    }
    if (rows.length) this.engine.kick();
  }

  /**
   * Repairs derived state without reprocessing everything: missing index rows (index.db lost or
   * schema bumped), missing vectors for the active embedding profile, missing projections.
   */
  reconcile() {
    const counts = this.engine.idx.documentChunkCounts();
    const embedder = this.engine.embedder();
    const docs = this.db
      .query(
        "SELECT id, kb_id, revision, origin, content, index_state, parse_state FROM kb_documents",
      )
      .all() as Pick<
      DocRow,
      "id" | "kb_id" | "revision" | "origin" | "content" | "index_state" | "parse_state"
    >[];
    const active = new Set(
      (
        this.db
          .query(
            "SELECT document_id || '@' || revision || ':' || kind AS k FROM kb_jobs WHERE status IN ('queued','running')",
          )
          .all() as {
          k: string;
        }[]
      ).map((r) => r.k),
    );
    let queued = 0;
    for (const d of docs) {
      const has = (kind: string) => active.has(`${d.id}@${d.revision}:${kind}`);
      if (
        d.origin === "authored" &&
        d.content !== null &&
        !this.engine.storage.hasProjection(d.kb_id, d.id)
      )
        this.engine.storage.putProjection(d.kb_id, d.id, d.content);
      if (d.parse_state === "pending" || d.parse_state === "failed" || has("parse") || has("index"))
        continue;
      const ready = d.index_state === "lexical_ready" || d.index_state.startsWith("semantic");
      if (ready && !counts.has(d.id)) {
        this.catalog.enqueue(d.kb_id, d.id, d.revision, "index", ulid());
        queued++;
        continue;
      }
      if (!ready) continue;
      if (embedder && !this.engine.idx.fullyEmbedded(embedder.profile, d.id)) {
        this.db.run("UPDATE kb_documents SET index_state = 'semantic_pending' WHERE id = ?", [
          d.id,
        ]);
        if (!has("embed")) {
          this.catalog.enqueue(d.kb_id, d.id, d.revision, "embed", ulid());
          queued++;
        }
      } else if (embedder && d.index_state !== "semantic_ready") {
        this.db.run("UPDATE kb_documents SET index_state = 'semantic_ready' WHERE id = ?", [d.id]);
      } else if (!embedder && d.index_state !== "lexical_ready") {
        this.db.run("UPDATE kb_documents SET index_state = 'lexical_ready' WHERE id = ?", [d.id]);
      }
    }
    // Docs with no parse job at all (crash between commit and enqueue cannot happen - same
    // transaction - but a manually cleared job table can) are requeued.
    for (const d of docs)
      if (
        d.parse_state === "pending" &&
        d.origin !== "authored" &&
        !active.has(`${d.id}@${d.revision}:parse`)
      ) {
        this.catalog.enqueue(d.kb_id, d.id, d.revision, "parse", ulid());
        queued++;
      }
    if (queued) this.engine.kick();
    return queued;
  }

  // --- Registered folders (external sources) -------------------------------------------------

  listSources(kbId: string): (KbSource & { document_count: number })[] {
    this.kbOrThrow(kbId);
    return this.db
      .query(
        `SELECT s.*, (SELECT count(*) FROM kb_documents d WHERE d.source_id = s.id) AS document_count
         FROM kb_sources s WHERE s.kb_id = ? ORDER BY s.root_path`,
      )
      .all(kbId) as (KbSource & { document_count: number })[];
  }

  private sourceOrThrow(id: string): SourceRow {
    const s = sourceOf(this.engine, id);
    if (!s) throw new NotFoundError("Source", id);
    return s;
  }

  /**
   * Copies a local folder into the KB. ORC only reads the folder: copies follow their file on
   * every rescan until edited in ORC, which detaches them.
   */
  addSource(ctx: KbCallContext, kbId: string, input: { root_path: string; pattern?: string }) {
    this.requireManager(ctx, "register folders");
    this.kbOrThrow(kbId);
    let root: string;
    try {
      root = validateCollectionPath(input.root_path);
    } catch (err) {
      if (err instanceof PathValidationError) throw new ValidationError(err.message);
      throw err;
    }
    const pattern = input.pattern?.trim() || DEFAULT_SOURCE_PATTERN;
    if (pattern.length > 300 || pattern.startsWith("/") || pattern.includes(".."))
      throw new ValidationError("Pattern must be a relative glob such as **/*.md");
    if (this.db.query("SELECT 1 FROM kb_sources WHERE kb_id = ? AND root_path = ?").get(kbId, root))
      throw new ConflictError(`${root} is already registered in this knowledge base`);
    const id = ulid();
    this.db.run(
      "INSERT INTO kb_sources (id, kb_id, root_path, pattern, last_scan_at, last_error, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)",
      [id, kbId, root, pattern, Date.now()],
    );
    const scan = this.scanSource(id);
    return { source: this.sourceOrThrow(id), scan };
  }

  /** Unregisters a folder: its copies leave the KB. The files themselves are untouched. */
  removeSource(ctx: KbCallContext, id: string) {
    this.requireManager(ctx, "remove folders");
    const source = this.sourceOrThrow(id);
    const docs = this.db
      .query(`SELECT ${DOC_COLUMNS} FROM kb_documents WHERE source_id = ?`)
      .all(id) as DocRow[];
    for (const d of docs) this.removeDocumentRecord(d, false);
    this.db.run("DELETE FROM kb_sources WHERE id = ?", [id]);
    resolveKbLinks(this.db, source.kb_id);
  }

  /** Reconciles a folder with its copies: new, changed and missing files. Detached copies are left alone. */
  scanSource(id: string): KbSourceScan {
    const source = this.sourceOrThrow(id);
    const result: KbSourceScan = { added: 0, updated: 0, missing: 0, unchanged: 0, errors: [] };
    const known = new Map(
      (
        this.db
          .query(`SELECT ${DOC_COLUMNS} FROM kb_documents WHERE source_id = ?`)
          .all(id) as DocRow[]
      ).map((d) => [d.external_path ?? "", d]),
    );
    const seen = new Set<string>();
    const limit = this.cfg().max_upload_bytes;
    const prefix = basename(source.root_path) || "folder";
    let files: string[] = [];
    try {
      files = [
        ...new Bun.Glob(source.pattern).scanSync({
          cwd: source.root_path,
          onlyFiles: true,
          followSymlinks: false,
        }),
      ]
        .map((f) => f.split(sep).join("/"))
        .filter((f) => !f.split("/").some((p) => p.startsWith(".") || p === "node_modules"))
        .sort();
    } catch (err) {
      result.errors.push(`Cannot read folder: ${(err as Error).message}`);
    }
    if (files.length > MAX_SOURCE_FILES) {
      result.errors.push(`Only the first ${MAX_SOURCE_FILES} of ${files.length} files are indexed`);
      files = files.slice(0, MAX_SOURCE_FILES);
    }
    for (const rel of files) {
      const ext = extname(rel).slice(1).toLowerCase();
      if (!KB_UPLOAD_FORMATS.includes(ext)) continue;
      // Seen even when unreadable, so a transient read error does not mark the document missing.
      seen.add(rel);
      const existing = known.get(rel);
      if (existing?.folder_detached) {
        result.unchanged++;
        continue;
      }
      try {
        const file = externalFile(source, rel);
        // Size first: an oversized file must not be read into memory on every rescan.
        if (statSync(file).size > limit)
          throw new Error(`larger than the ${Math.round(limit / 1048576)} MB limit`);
        const bytes = readFileSync(file);
        const outcome = this.syncExternalFile(
          source,
          rel,
          `${prefix}/${rel}`,
          ext,
          bytes,
          existing,
        );
        result[outcome]++;
      } catch (err) {
        result.errors.push(`${rel}: ${(err as Error).message}`);
      }
    }
    // A vanished file keeps its copy searchable; the warning says it no longer follows anything.
    for (const [rel, doc] of known) {
      if (seen.has(rel) || doc.folder_detached || doc.warnings.includes(SOURCE_MISSING)) continue;
      const warnings = [...(JSON.parse(doc.warnings) as string[]), SOURCE_MISSING];
      this.db.run("UPDATE kb_documents SET warnings = ? WHERE id = ?", [
        JSON.stringify(warnings),
        doc.id,
      ]);
      result.missing++;
    }
    this.db.run("UPDATE kb_sources SET last_scan_at = ?, last_error = ? WHERE id = ?", [
      Date.now(),
      result.errors.length ? result.errors.slice(0, 20).join("\n").slice(0, 4000) : null,
      id,
    ]);
    if (result.added || result.updated || result.missing) {
      resolveKbLinks(this.db, source.kb_id);
      this.engine.kick();
    }
    return result;
  }

  /** Brings one folder file's copy up to date: Markdown text into the catalog, other bytes into originals/. */
  private syncExternalFile(
    source: SourceRow,
    rel: string,
    path: string,
    ext: string,
    bytes: Uint8Array,
    existing: DocRow | undefined,
  ): "added" | "updated" | "unchanged" {
    const hash = sha256(bytes);
    const markdown = ext === "md" || ext === "markdown";
    const text = markdown ? decodeUtf8(bytes) : null;
    if (markdown && text === null) throw new Error("Markdown must be UTF-8");
    const now = Date.now();
    const ctx: KbCallContext = { source: "api", actor: { name: SCANNER } };
    const parseState = markdown ? "ok" : "pending";
    const kind = markdown ? "index" : "parse";
    if (existing) {
      const wasMissing = existing.warnings.includes(SOURCE_MISSING);
      const warnings = JSON.stringify(
        (JSON.parse(existing.warnings) as string[]).filter((w) => w !== SOURCE_MISSING),
      );
      if (existing.content_hash === hash) {
        if (!wasMissing) return "unchanged";
        this.db.run("UPDATE kb_documents SET warnings = ? WHERE id = ?", [warnings, existing.id]);
        return "updated";
      }
      const revision = existing.revision + 1;
      const originalRel = markdown
        ? null
        : this.engine.storage.putOriginal(source.kb_id, existing.id, revision, ext, bytes);
      const next: DocRow = {
        ...existing,
        revision,
        content: text,
        content_hash: hash,
        size_bytes: bytes.byteLength,
        parse_state: parseState,
        index_state: "pending",
        warnings: markdown ? warnings : "[]",
        updated_at: now,
        updated_by: SCANNER,
      };
      this.db.transaction(() => {
        const res = this.db.run(
          `UPDATE kb_documents SET revision = ?, content = ?, content_hash = ?, size_bytes = ?, parse_state = ?,
             index_state = 'pending', warnings = ?, updated_at = ?, updated_by = ?
           WHERE id = ? AND revision = ? AND folder_detached = 0`,
          [
            revision,
            text,
            hash,
            next.size_bytes,
            parseState,
            next.warnings,
            now,
            SCANNER,
            existing.id,
            existing.revision,
          ],
        );
        if (!res.changes) throw new Error("the copy changed while scanning; rescan to retry");
        this.insertRevision(
          next,
          ctx,
          wasMissing ? "File reappeared" : "File changed in folder",
          originalRel,
        );
        this.catalog.enqueue(source.kb_id, existing.id, revision, kind, ulid());
        this.markDependentsStale(existing.id);
      })();
      if (text !== null) this.engine.storage.putProjection(source.kb_id, existing.id, text);
      return "updated";
    }
    if (this.catalog.docByPath(source.kb_id, path))
      throw new Error(`another document already uses the path ${path}`);
    const name = rel.split("/").pop() ?? rel;
    const id = ulid();
    const originalRel = markdown
      ? null
      : this.engine.storage.putOriginal(source.kb_id, id, 1, ext, bytes);
    const doc: DocRow = {
      id,
      kb_id: source.kb_id,
      title:
        (text !== null ? firstHeading(stripFrontmatter(text)) : undefined) ??
        name.replace(/\.[^.]+$/, ""),
      description: "",
      path,
      labels: "[]",
      origin: "external",
      media_type: mediaTypeOf(name),
      original_name: name,
      size_bytes: bytes.byteLength,
      content_hash: hash,
      revision: 1,
      content: text,
      source_id: source.id,
      external_path: rel,
      folder_detached: 0,
      parse_state: parseState,
      index_state: "pending",
      parser_id: null,
      parser_version: null,
      parser_options_hash: null,
      warnings: "[]",
      derived_from: "[]",
      stale: 0,
      created_at: now,
      updated_at: now,
      updated_by: SCANNER,
    };
    this.db.transaction(() => {
      this.insertDocument(doc);
      this.insertRevision(doc, ctx, `Copied from ${source.root_path}`, originalRel);
      this.catalog.enqueue(source.kb_id, doc.id, 1, kind, ulid());
    })();
    if (text !== null) this.engine.storage.putProjection(source.kb_id, doc.id, text);
    return "added";
  }

  scanAllSources() {
    const ids = (this.db.query("SELECT id FROM kb_sources").all() as { id: string }[]).map(
      (r) => r.id,
    );
    for (const id of ids) {
      try {
        this.scanSource(id);
      } catch (err) {
        this.db.run("UPDATE kb_sources SET last_error = ? WHERE id = ?", [
          (err as Error).message.slice(0, 4000),
          id,
        ]);
      }
    }
  }

  /** What a maintainer should look at: stale derived docs, failed files, links to nothing. */
  maintenanceQueue(kbId: string): KbMaintenanceQueue {
    this.kbOrThrow(kbId);
    const docs = (where: string) =>
      (
        this.db
          .query(
            `SELECT ${DOC_COLUMNS} FROM kb_documents WHERE kb_id = ? AND ${where} ORDER BY updated_at DESC LIMIT 200`,
          )
          .all(kbId) as DocRow[]
      ).map(toDoc);
    const unresolved = this.db
      .query(
        `SELECT l.target, l.from_id AS document_id, d.title FROM kb_links l JOIN kb_documents d ON d.id = l.from_id
         WHERE l.kb_id = ? AND l.to_id IS NULL ORDER BY l.target LIMIT 500`,
      )
      .all(kbId) as { target: string; document_id: string; title: string }[];
    return {
      stale: docs("stale = 1"),
      failed: docs("(parse_state = 'failed' OR index_state = 'failed')"),
      unresolved_links: unresolved,
    };
  }

  /** Periodic upkeep: registered folder rescans, usage retention, finished job cleanup. */
  maintain() {
    try {
      this.jobs.recoverExpired();
      this.scanAllSources();
      this.usage.prune(this.cfg().usage_retention_days);
      this.db.run("DELETE FROM kb_jobs WHERE status IN ('done', 'superseded') AND updated_at < ?", [
        Date.now() - 7 * 86_400_000,
      ]);
    } catch (err) {
      console.error(`[knowledge] maintenance failed: ${(err as Error).message}`);
    }
  }
}

const target = (d: Pick<DocRow, "id" | "kb_id" | "revision">): UsageTarget => ({
  document_id: d.id,
  kb_id: d.kb_id,
  revision: d.revision,
});

const normalizeLabels = (labels: string[]) =>
  [
    ...new Set(labels.map((l) => l.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean)),
  ].sort();

/** Markdown of one heading's section (until the next heading of the same or higher level). */
function sectionOf(blocks: ReturnType<typeof markdownToBlocks>, heading: string): string | null {
  const want = heading.trim().toLowerCase();
  const start = blocks.findIndex(
    (b) => b.kind === "heading" && b.text.trim().toLowerCase() === want,
  );
  if (start < 0) return null;
  const level = blocks[start]?.level ?? 1;
  const out: string[] = [];
  for (let i = start; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b) break;
    if (i > start && b.kind === "heading" && (b.level ?? 1) <= level) break;
    out.push(b.kind === "heading" ? `${"#".repeat(b.level ?? 1)} ${b.text}` : b.text);
  }
  return out.join("\n\n");
}
