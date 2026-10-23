import { createHash } from "node:crypto";
import type { OrcConfig } from "@orc/core/config";
import { validateVector } from "./vector.js";

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

/** Retrieval instructions from upstream model cards; documents for these models stay unprefixed. */
function retrievalQuery(model: string, text: string): string {
  const name = model.toLowerCase().split("/").at(-1) ?? model;
  if (/^mxbai-embed-large(?:[:-]|$)/.test(name))
    return `Represent this sentence for searching relevant passages: ${text}`;
  if (/^qwen3-embedding(?:[:-]|$)/.test(name))
    return `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ${text}`;
  return text;
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
  } catch {
    throw new EmbeddingError("Embedding endpoint unreachable", true);
  }
  if (!res.ok) {
    // Provider bodies may echo credentials or private input. Never expose them
    // through job errors, logs or the search API's degraded message.
    await res.body?.cancel();
    throw new EmbeddingError(
      `Embedding request failed (${res.status})`,
      res.status === 408 || res.status === 429 || res.status >= 500,
    );
  }
  try {
    const json: unknown = await res.json();
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error();
    return json as Record<string, unknown>;
  } catch {
    throw new EmbeddingError("Embedding response is not a JSON object", false);
  }
}

export function validateEmbeddingVectors(
  vectors: unknown,
  count: number,
  dims?: number,
): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count)
    throw new EmbeddingError("Embedding response has the wrong number of vectors", false);
  let dimensions = dims;
  for (const v of vectors) {
    if (!Array.isArray(v))
      throw new EmbeddingError("Embedding response has an invalid vector", false);
    dimensions ??= v.length;
    try {
      validateVector(v, dimensions);
    } catch {
      throw new EmbeddingError(
        "Embedding response has invalid vectors or inconsistent dimensions",
        false,
      );
    }
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
        if (!texts.length) return [];
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
            input: texts.map((t) =>
              prefix ? prefix + t : kind === "query" ? retrievalQuery(model, t) : t,
            ),
            truncate: false,
            ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}),
          },
          cfg.timeout_secs,
          // Local Ollama needs none; a hosted or proxied one takes a bearer token.
          cfg.api_key,
        );
        return validateEmbeddingVectors(json.embeddings, texts.length, cfg.dimensions);
      },
    };
  }
  return {
    provider: "openai",
    model,
    profile,
    batchSize: cfg.batch_size,
    async embed(texts, kind) {
      if (!texts.length) return [];
      const json = await post(
        `${base}/embeddings`,
        {
          model,
          input: kind === "query" ? texts.map((text) => retrievalQuery(model, text)) : texts,
          ...(cfg.dimensions ? { dimensions: cfg.dimensions } : {}),
        },
        cfg.timeout_secs,
        cfg.api_key,
      );
      const data = json.data;
      if (!Array.isArray(data) || data.length !== texts.length)
        throw new EmbeddingError("Embedding response has the wrong number of vectors", false);
      const indices = new Set<number>();
      for (const row of data) {
        if (
          !row ||
          typeof row !== "object" ||
          !Number.isInteger(row.index) ||
          row.index < 0 ||
          row.index >= texts.length ||
          indices.has(row.index)
        )
          throw new EmbeddingError("Embedding response has invalid input indices", false);
        indices.add(row.index);
      }
      const sorted = [...data].sort((a, b) => a.index - b.index);
      return validateEmbeddingVectors(
        sorted?.map((d) => d.embedding),
        texts.length,
        cfg.dimensions,
      );
    },
  };
}
