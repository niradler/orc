import { createHash } from "node:crypto";
import type { OrcConfig } from "@orc/core/config";

export type EmbeddingConfig = OrcConfig["knowledge"]["embedding"];

export type EmbeddingProvider = {
  provider: "ollama" | "openai";
  model: string;
  /** Identifies the vector space; vectors from different profiles are never compared. */
  profile: string;
  batchSize: number;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
};

const DEFAULTS = {
  ollama: { base_url: "http://localhost:11434", model: "nomic-embed-text" },
  openai: { base_url: "https://api.openai.com/v1", model: "text-embedding-3-small" },
} as const;

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

async function post(url: string, body: unknown, timeoutSecs: number, apiKey?: string) {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutSecs * 1000),
    });
  } catch (e) {
    throw new EmbeddingError(`Embedding endpoint unreachable: ${(e as Error).message}`, true);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new EmbeddingError(
      `Embedding request failed (${res.status}): ${text}`,
      res.status === 429 || res.status >= 500,
    );
  }
  return (await res.json()) as Record<string, unknown>;
}

function checkVectors(vectors: unknown, count: number, dims?: number): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count)
    throw new EmbeddingError("Embedding response has the wrong number of vectors", false);
  for (const v of vectors) {
    if (!Array.isArray(v) || !v.length || (dims && v.length !== dims))
      throw new EmbeddingError(
        `Embedding response has unexpected dimensions${dims ? ` (expected ${dims})` : ""}`,
        false,
      );
  }
  return vectors as number[][];
}

export function createEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider | null {
  if (cfg.provider === "none") return null;
  const base = (cfg.base_url || DEFAULTS[cfg.provider].base_url).replace(/\/+$/, "");
  const model = cfg.model || DEFAULTS[cfg.provider].model;
  const profile = createHash("sha256")
    .update(JSON.stringify([cfg.provider, base, model, cfg.dimensions ?? null]))
    .digest("hex")
    .slice(0, 16);

  if (cfg.provider === "ollama") {
    return {
      provider: "ollama",
      model,
      profile,
      batchSize: cfg.batch_size,
      async embed(texts, kind) {
        // nomic-embed models are trained with task prefixes; without them recall drops noticeably.
        const prefix = /nomic-embed/i.test(model)
          ? kind === "query"
            ? "search_query: "
            : "search_document: "
          : "";
        const json = await post(
          `${base}/api/embed`,
          {
            model,
            input: texts.map((t) => prefix + t),
            truncate: true,
            ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}),
          },
          cfg.timeout_secs,
          // Local Ollama needs none; a hosted or proxied one takes a bearer token.
          cfg.api_key,
        );
        return checkVectors(json.embeddings, texts.length, cfg.dimensions);
      },
    };
  }
  return {
    provider: "openai",
    model,
    profile,
    batchSize: cfg.batch_size,
    async embed(texts) {
      const json = await post(
        `${base}/embeddings`,
        { model, input: texts, ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}) },
        cfg.timeout_secs,
        cfg.api_key,
      );
      const data = json.data as { index: number; embedding: number[] }[] | undefined;
      const sorted = Array.isArray(data) ? [...data].sort((a, b) => a.index - b.index) : data;
      return checkVectors(
        sorted?.map((d) => d.embedding),
        texts.length,
        cfg.dimensions,
      );
    },
  };
}
