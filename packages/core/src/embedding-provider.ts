import { loadConfig, type OrcConfig } from "./config.js";
import type { EmbeddingProvider } from "./retrieval.js";

export function configuredEmbeddingProvider(
  settings: OrcConfig["knowledge"]["embeddings"] = loadConfig().knowledge.embeddings,
): EmbeddingProvider | undefined {
  if (!settings) return undefined;
  return {
    model: settings.model,
    dimensions: settings.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const endpoint = new URL(settings.endpoint);
      if (!["http:", "https:"].includes(endpoint.protocol))
        throw new Error("Invalid embedding endpoint protocol");
      if (endpoint.username || endpoint.password)
        throw new Error("Embedding credentials must use secret_env");
      if (
        !settings.allow_hosted &&
        !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
      )
        throw new Error("Hosted embeddings require explicit allow_hosted configuration");
      const secret = settings.secret_env ? process.env[settings.secret_env] : undefined;
      if (settings.secret_env && !secret) throw new Error("Embedding credential unavailable");
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({ model: settings.model, input: texts }),
        signal: AbortSignal.timeout(settings.timeout_ms),
      });
      if (!response.ok) throw new Error("Embedding provider request failed");
      const result = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
      if (!Array.isArray(result.data) || result.data.length !== texts.length)
        throw new Error("Invalid embedding provider response");
      const sorted = [...result.data].sort((a, b) => a.index - b.index);
      if (
        !sorted.every(
          (item, index) =>
            item.index === index &&
            Array.isArray(item.embedding) &&
            item.embedding.length === settings.dimensions &&
            item.embedding.every(Number.isFinite),
        )
      )
        throw new Error("Invalid embedding provider vectors");
      return sorted.map((item) => item.embedding);
    },
  };
}
