import type { Database } from "bun:sqlite";
import type { OrcConfig } from "@orc/core/config";
import type { Catalog } from "./catalog.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { IndexDb } from "./index-db.js";
import type { KnowledgeStorage } from "./storage.js";

export type KnowledgeConfig = OrcConfig["knowledge"];

/** Shared internals the service, job runner and search operate on. */
export type Engine = {
  db: Database;
  catalog: Catalog;
  idx: IndexDb;
  storage: KnowledgeStorage;
  config: () => KnowledgeConfig;
  embedder: () => EmbeddingProvider | null;
  /** Wake the job runner after enqueueing work. */
  kick: () => void;
};
