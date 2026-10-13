/**
 * QmdKnowledgeEngine - implements KnowledgeEngine using @tobilu/qmd SDK.
 *
 * QMD manages its own SQLite DB at ~/.orc/knowledge.db (configurable).
 * Project scoping is stored in orc.db (knowledge_collections table).
 * The store is lazily initialized on first use and auto-creates the DB.
 */

import { loadConfig } from "@orc/core/config";
import { NotFoundError, OrcError, ValidationError } from "@orc/core/errors";
import type {
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeEngine,
  KnowledgeSearchMode,
  KnowledgeSearchResult,
  KnowledgeStatus,
} from "@orc/core/knowledge";
import {
  editKnowledgeFile,
  readKnowledgeFile,
  resolveKnowledgeFile,
} from "@orc/core/knowledge-files";
import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { knowledge_collections } from "@orc/db/schema";
import type { HybridQueryResult, QMDStore, SearchResult } from "@tobilu/qmd";
import { eq } from "drizzle-orm";
import { validateKnowledgePattern } from "./knowledge-pattern.js";

const logger = createLogger("knowledge:qmd");

// Lazy-load @tobilu/qmd so that its transitive static import of `node-llama-cpp`
// (pulled in by `qmd/llm.js`) doesn't fire at module load. Compiled standalone
// binaries and npm users without the optional native dep installed should still
// be able to start the CLI - the knowledge feature surfaces a clear error on use
// instead of crashing on boot.
let _qmd: typeof import("@tobilu/qmd") | null = null;
async function loadQmd(): Promise<typeof import("@tobilu/qmd")> {
  if (_qmd) return _qmd;
  try {
    _qmd = await import("@tobilu/qmd");
    return _qmd;
  } catch (err) {
    throw new OrcError(
      "Knowledge feature requires @tobilu/qmd (and its native node-llama-cpp dependency). " +
        "Install with: npm install @tobilu/qmd node-llama-cpp. " +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      "KNOWLEDGE_UNAVAILABLE",
      503,
    );
  }
}

export class QmdKnowledgeEngine implements KnowledgeEngine {
  private store: QMDStore | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? loadConfig().knowledge.db_path;
  }

  private async getStore(): Promise<QMDStore> {
    if (this.store) return this.store;
    logger.info("Initializing QMD knowledge store", { dbPath: this.dbPath });
    const { createStore } = await loadQmd();
    this.store = await createStore({ dbPath: this.dbPath });
    return this.store;
  }

  /** Get collection names belonging to a project from orc.db */
  private getProjectCollectionNames(projectId: string): string[] {
    const db = getDb();
    const rows = db
      .select({ name: knowledge_collections.name })
      .from(knowledge_collections)
      .where(eq(knowledge_collections.project_id, projectId))
      .all();
    return rows.map((r) => r.name);
  }

  async search(
    query: string,
    opts?: {
      collection?: string;
      project_id?: string;
      limit?: number;
      mode?: KnowledgeSearchMode;
    },
  ): Promise<KnowledgeSearchResult[]> {
    const config = loadConfig();
    const store = await this.getStore();
    const limit = opts?.limit ?? config.knowledge.default_limit;
    const mode = opts?.mode ?? (config.knowledge.search_mode as KnowledgeSearchMode);

    // Determine which collections to search
    let collectionNames: string[] | null = null;
    if (opts?.collection) {
      if (
        opts.project_id &&
        !this.getProjectCollectionNames(opts.project_id).includes(opts.collection)
      )
        return [];
      collectionNames = [opts.collection];
    } else if (opts?.project_id) {
      collectionNames = this.getProjectCollectionNames(opts.project_id);
      if (collectionNames.length === 0) return [];
    }

    // If single collection or no filter, do one search
    if (!collectionNames || collectionNames.length === 1) {
      const col = collectionNames?.[0];
      if (mode === "lexical") {
        const results = await store.searchLex(query, {
          limit,
          ...(col ? { collection: col } : {}),
        });
        return results.map((r) => this.mapSearchResult(r, query));
      }
      const results = await store.search({
        query,
        limit,
        ...(col ? { collection: col } : {}),
      });
      return results.map((r) => this.mapHybridResult(r, query));
    }

    // Multi-collection: search each and merge by score
    const allResults: KnowledgeSearchResult[] = [];
    for (const col of collectionNames) {
      if (mode === "lexical") {
        const results = await store.searchLex(query, {
          limit,
          collection: col,
        });
        allResults.push(...results.map((r) => this.mapSearchResult(r, query)));
      } else {
        const results = await store.search({ query, limit, collection: col });
        allResults.push(...results.map((r) => this.mapHybridResult(r, query)));
      }
    }
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  async get(docidOrPath: string): Promise<KnowledgeDocument | null> {
    const store = await this.getStore();
    const result = await store.get(docidOrPath, { includeBody: true });
    if ("error" in result) return null;
    const document: KnowledgeDocument = {
      docid: result.docid,
      path: result.displayPath,
      collection: result.collectionName,
      title: result.title,
      content: result.body ?? "",
      modifiedAt: result.modifiedAt,
    };
    try {
      const source = await this.resolveSource(document);
      document.content = readKnowledgeFile(
        resolveKnowledgeFile(source.document, source.collection),
      );
      document.editable = true;
    } catch (cause) {
      if (!(cause instanceof ValidationError) && (cause as NodeJS.ErrnoException).code !== "ENOENT")
        throw cause;
      document.editable = false;
      document.readOnlyReason =
        "The indexed source is unavailable, ambiguous, or not an editable UTF-8 Markdown file.";
    }
    return document;
  }

  private async resolveSource(
    document: KnowledgeDocument,
  ): Promise<{ document: KnowledgeDocument; collection: KnowledgeCollection }> {
    const collection = (await this.listCollections()).find(
      (entry) => entry.name === document.collection,
    );
    if (!collection) throw new ValidationError("The source collection is no longer registered");
    validateKnowledgePattern(collection.pattern);
    // QMD normalizes filenames when indexing (e.g. spaces become dashes).
    // Use its own normalization and require one unique physical source, never guess a write target.
    const { handelize } = (await import(
      new URL("./store.js", import.meta.resolve("@tobilu/qmd")).href
    )) as { handelize: (path: string) => string };
    const relativePath = document.path.slice(`${collection.name}/`.length);
    const matches: string[] = [];
    const ignored = new Set(["node_modules", ".git", ".cache", "vendor", "dist", "build"]);
    for await (const entry of new Bun.Glob(collection.pattern).scan({
      cwd: collection.path,
      onlyFiles: true,
      followSymlinks: false,
      dot: false,
    })) {
      const filename = entry.replace(/\\/g, "/");
      if (filename.split("/").some((part) => part.startsWith(".") || ignored.has(part))) continue;
      if (handelize(filename) === relativePath) matches.push(filename);
      if (matches.length > 1) break;
    }
    if (matches.length !== 1)
      throw new ValidationError("The indexed document does not have one unique source file");
    return { document: { ...document, path: `${collection.name}/${matches[0]}` }, collection };
  }

  async edit(
    docidOrPath: string,
    content: string,
    expectedContent: string,
  ): Promise<KnowledgeDocument> {
    const document = await this.get(docidOrPath);
    if (!document) throw new NotFoundError("Document", docidOrPath);
    if (
      ![document.docid, `#${document.docid}`, document.path, `qmd://${document.path}`].includes(
        docidOrPath,
      )
    )
      throw new ValidationError("Use the exact indexed document ID or path when editing");
    const source = await this.resolveSource(document);
    editKnowledgeFile(source.document, source.collection, content, expectedContent);
    // The source file is already saved. Indexing can be retried independently.
    let indexingWarning: string | undefined;
    try {
      await this.update({ collections: [document.collection] });
    } catch (cause) {
      logger.warn("Document saved, but knowledge reindex failed", { error: String(cause) });
      indexingWarning =
        "The source file was saved, but the search index could not be updated. Reindex this collection to refresh search results.";
    }
    const saved = (await this.get(`qmd://${document.path}`)) ?? { ...document, content };
    return { ...saved, ...(indexingWarning ? { indexingWarning } : {}) };
  }

  async listCollections(opts?: { project_id?: string }): Promise<KnowledgeCollection[]> {
    const store = await this.getStore();
    const collections = await store.listCollections();

    // Build project_id lookup from orc.db
    const db = getDb();
    const mappings = db.select().from(knowledge_collections).all();
    const projectMap = new Map(mappings.map((m) => [m.name, m.project_id]));

    let filtered = collections;
    if (opts?.project_id) {
      const projectNames = new Set(this.getProjectCollectionNames(opts.project_id));
      filtered = collections.filter((c) => projectNames.has(c.name));
    }

    return filtered.map((c) => ({
      name: c.name,
      path: c.pwd,
      pattern: c.glob_pattern,
      documentCount: c.doc_count,
      lastModified: c.last_modified,
      projectId: projectMap.get(c.name) ?? null,
    }));
  }

  async addCollection(
    name: string,
    opts: { path: string; pattern?: string; project_id?: string },
  ): Promise<void> {
    validateKnowledgePattern(opts.pattern ?? "**/*.md");
    const store = await this.getStore();
    await store.addCollection(name, {
      path: opts.path,
      ...(opts.pattern ? { pattern: opts.pattern } : {}),
    });
    await store.update({ collections: [name] });

    // Auto-embed when hybrid mode is configured
    const config = loadConfig();
    if (config.knowledge.search_mode === "hybrid") {
      try {
        await store.embed();
      } catch (err) {
        logger.warn("Embedding failed after adding collection", {
          error: String(err),
        });
      }
    }

    // Store project mapping in orc.db
    const db = getDb();
    const now = new Date();
    await db
      .insert(knowledge_collections)
      .values({
        name,
        project_id: opts.project_id ?? null,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: knowledge_collections.name,
        set: {
          project_id: opts.project_id ?? null,
          updated_at: now,
        },
      });
  }

  async removeCollection(name: string): Promise<boolean> {
    const store = await this.getStore();
    const removed = store.removeCollection(name);

    // Clean up orc.db mapping
    const db = getDb();
    await db.delete(knowledge_collections).where(eq(knowledge_collections.name, name));

    return removed;
  }

  async update(opts?: {
    collections?: string[];
  }): Promise<{ indexed: number; updated: number; removed: number }> {
    const config = loadConfig();
    const store = await this.getStore();
    const collections = await store.listCollections();
    for (const collection of collections) {
      if (!opts?.collections || opts.collections.includes(collection.name))
        validateKnowledgePattern(collection.glob_pattern);
    }
    const result = await store.update(opts?.collections ? { collections: opts.collections } : {});

    // Auto-embed when hybrid mode is configured - enables vector search + reranking
    if (config.knowledge.search_mode === "hybrid" && (result.indexed > 0 || result.updated > 0)) {
      logger.info("Hybrid mode configured - generating embeddings for new/updated documents");
      try {
        const embedResult = await store.embed();
        logger.info("Embedding complete", {
          docsProcessed: embedResult.docsProcessed,
          chunksEmbedded: embedResult.chunksEmbedded,
        });
      } catch (err) {
        logger.warn("Embedding failed (hybrid search may return degraded results)", {
          error: String(err),
        });
      }
    }

    return {
      indexed: result.indexed,
      updated: result.updated,
      removed: result.removed,
    };
  }

  async getStatus(): Promise<KnowledgeStatus> {
    const config = loadConfig();
    const store = await this.getStore();
    const status = await store.getStatus();
    const collections = await this.listCollections();
    return {
      collections,
      totalDocuments: status.totalDocuments,
      dbPath: this.dbPath,
      searchMode: config.knowledge.search_mode,
    };
  }

  async close(): Promise<void> {
    if (this.store) {
      await this.store.close();
      this.store = null;
    }
  }

  private mapSearchResult(r: SearchResult, query: string): KnowledgeSearchResult {
    // getStore() has already loaded qmd by the time this is invoked from search paths
    const extractSnippet = _qmd?.extractSnippet;
    const snippet = r.body && extractSnippet ? extractSnippet(r.body, query, 120).snippet : r.title;
    return {
      docid: r.docid,
      path: r.displayPath,
      collection: r.collectionName,
      title: r.title,
      snippet,
      score: r.score,
    };
  }

  private mapHybridResult(r: HybridQueryResult, query: string): KnowledgeSearchResult {
    const extractSnippet = _qmd?.extractSnippet;
    const snippet =
      r.bestChunk && extractSnippet ? extractSnippet(r.bestChunk, query, 120).snippet : r.title;
    return {
      docid: r.docid,
      path: r.displayPath,
      collection: r.displayPath.split("/")[0] ?? "",
      title: r.title,
      snippet,
      score: r.score,
    };
  }
}

let _engine: QmdKnowledgeEngine | null = null;

export function getKnowledgeEngine(): KnowledgeEngine {
  if (!_engine) _engine = new QmdKnowledgeEngine();
  return _engine;
}

export function closeKnowledgeEngine(): Promise<void> {
  if (_engine) {
    const engine = _engine;
    _engine = null;
    return engine.close();
  }
  return Promise.resolve();
}
