/**
 * KnowledgeEngine - backend-agnostic interface for document search.
 *
 * ORC wraps the search backend (currently QMD) behind this interface
 * so the implementation can be swapped without touching consumers.
 */

export type KnowledgeCollection = {
  name: string;
  path: string;
  pattern: string;
  documentCount: number;
  lastModified: string | null;
  projectId: string | null;
};

export type KnowledgeSearchResult = {
  docid: string;
  path: string;
  collection: string;
  title: string;
  snippet: string;
  score: number;
};

export type KnowledgeDocument = {
  docid: string;
  path: string;
  collection: string;
  title: string;
  content: string;
  modifiedAt: string;
};

export type KnowledgeStatus = {
  collections: KnowledgeCollection[];
  totalDocuments: number;
  dbPath: string;
  searchMode: string;
};

export type KnowledgeSearchMode = "hybrid" | "lexical";

export interface KnowledgeEngine {
  search(
    query: string,
    opts?: {
      collection?: string;
      project_id?: string;
      limit?: number;
      mode?: KnowledgeSearchMode;
    },
  ): Promise<KnowledgeSearchResult[]>;

  get(docidOrPath: string): Promise<KnowledgeDocument | null>;

  listCollections(opts?: { project_id?: string }): Promise<KnowledgeCollection[]>;

  addCollection(
    name: string,
    opts: { path: string; pattern?: string; project_id?: string },
  ): Promise<void>;

  removeCollection(name: string): Promise<boolean>;

  update(opts?: {
    collections?: string[];
  }): Promise<{ indexed: number; updated: number; removed: number }>;

  getStatus(): Promise<KnowledgeStatus>;

  close(): Promise<void>;
}
