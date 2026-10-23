import { EmbeddingError, type EmbeddingProvider, validateEmbeddingVectors } from "./embeddings.js";
import { embeddingInput, type IndexDb } from "./index-db.js";
import { decodeVector, encodeVector, validateVector } from "./vector.js";

/** Bounds request input bytes independently of the configured item count; not a tokenizer. */
export const EMBEDDING_BATCH_MAX_BYTES = 128 * 1024;
type Pending = ReturnType<IndexDb["pendingEmbeddings"]>[number];
type VectorRow = { chunk_id: number; hash: string; vector: Uint8Array };

/** Shared KB/session ingestion: reuse valid cache entries, deduplicate inputs and commit each valid request. */
export async function embedPendingBatch(
  index: IndexDb,
  provider: EmbeddingProvider,
  documentId?: string,
): Promise<number> {
  if (!Number.isInteger(provider.batchSize) || provider.batchSize < 1)
    throw new EmbeddingError("Invalid embedding batch size", false);
  const pending = index.pendingEmbeddings(provider.profile, provider.batchSize, documentId);
  const dimensions = index.vectorDimensions(provider.profile) ?? undefined;
  const cached: VectorRow[] = [];
  const fresh = new Map<string, { text: string; chunks: Pending[] }>();
  const cache = new Map<string, Uint8Array | null>();
  for (const chunk of pending) {
    if (!cache.has(chunk.input_hash)) {
      let vector = index.cachedEmbedding(provider.profile, chunk.input_hash);
      if (vector) {
        try {
          validateVector(decodeVector(vector), dimensions);
        } catch {
          vector = null;
        }
      }
      cache.set(chunk.input_hash, vector);
    }
    const vector = cache.get(chunk.input_hash);
    if (vector) cached.push({ chunk_id: chunk.id, hash: chunk.input_hash, vector });
    else {
      const group = fresh.get(chunk.input_hash) ?? { text: embeddingInput(chunk), chunks: [] };
      group.chunks.push(chunk);
      fresh.set(chunk.input_hash, group);
    }
  }
  if (cached.length) index.putVectors(provider.profile, cached);
  let batch: { text: string; chunks: Pending[] }[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    const vectors = validateEmbeddingVectors(
      await provider.embed(
        batch.map((item) => item.text),
        "document",
      ),
      batch.length,
      index.vectorDimensions(provider.profile) ?? undefined,
    );
    index.putVectors(
      provider.profile,
      batch.flatMap((item, i) => {
        const vector = vectors[i];
        if (!vector) throw new EmbeddingError("Missing embedding vector", false);
        const encoded = encodeVector(vector);
        return item.chunks.map((chunk) => ({
          chunk_id: chunk.id,
          hash: chunk.input_hash,
          vector: encoded,
        }));
      }),
    );
    batch = [];
    bytes = 0;
  };
  for (const item of fresh.values()) {
    const size = Buffer.byteLength(item.text, "utf8");
    if (size > EMBEDDING_BATCH_MAX_BYTES)
      throw new EmbeddingError(
        "Embedding input is too large; split the source into smaller passages",
        false,
      );
    if (batch.length && bytes + size > EMBEDDING_BATCH_MAX_BYTES) await flush();
    batch.push(item);
    bytes += size;
  }
  await flush();
  return pending.length;
}
