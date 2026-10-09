import { z } from "zod";

export const EvidenceSourceSchema = z.object({
  kind: z.enum(["memory", "document", "session", "wiki"]),
  source_id: z.string().min(1).max(500),
  project_id: z.string().min(1).nullable(),
  title: z.string().max(1000),
  content: z.string().min(1).max(2_000_000),
  location: z.string().max(2000),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  valid_until: z.number().int().nullable().default(null),
  metadata: z.record(z.string(), z.string()).default({}),
});

export const RetrievalQuerySchema = z.object({
  query: z.string().trim().min(1).max(2000),
  project_id: z.string().min(1).nullable(),
  kinds: z.array(z.enum(["memory", "document", "session", "wiki"])).optional(),
  tags_any: z.array(z.string().trim().min(1)).max(30).default([]),
  tags_all: z.array(z.string().trim().min(1)).max(30).default([]),
  topic_tags: z.array(z.string().trim().min(1)).max(30).default([]),
  limit: z.number().int().min(1).max(50).default(10),
  token_budget: z.number().int().min(64).max(32000).default(2000),
});

export type EvidenceSource = z.input<typeof EvidenceSourceSchema>;
export type RetrievalQuery = z.input<typeof RetrievalQuerySchema>;
export type Passage = {
  id: string;
  source_id: string;
  version: string;
  kind: "memory" | "document" | "session" | "wiki";
  project_id: string | null;
  title: string;
  location: string;
  headings: string[];
  structural_context: string | null;
  start: number;
  end: number;
  content: string;
  ordinal: number;
  tags: string[];
};
export type CitedPassage = Passage & { score: number; estimated_tokens: number };
export type RetrievalResult = {
  passages: CitedPassage[];
  estimated_tokens: number;
  capabilities: { lexical: true; semantic: "off" | "ready" | "degraded"; reason?: string };
};

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export function normalizeTags(tags: string[]): string[] {
  return [
    ...new Set(tags.map((tag) => tag.normalize("NFKC").trim().toLowerCase()).filter(Boolean)),
  ];
}
