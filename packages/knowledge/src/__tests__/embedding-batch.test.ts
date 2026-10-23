import { expect, test } from "bun:test";
import { EMBEDDING_BATCH_MAX_BYTES, embedPendingBatch } from "../embedding-batch.js";
import type { EmbeddingProvider } from "../embeddings.js";
import { IndexDb } from "../index-db.js";
import { encodeVector } from "../vector.js";

test("successful requests remain durable when a later request fails and retries resume only missing chunks", async () => {
  const index = await IndexDb.open(":memory:");
  let calls = 0;
  const p = provider(async (texts) => {
    calls++;
    if (calls === 2) throw new Error("temporary provider outage");
    return texts.map(() => [1, 0]);
  });
  try {
    document(
      index,
      "doc",
      ["a", "b", "c"].map((letter) => letter.repeat(70000)),
    );
    await expect(embedPendingBatch(index, p)).rejects.toThrow("temporary provider outage");
    expect(index.pendingEmbeddingCount(p.profile)).toBe(2);
    await embedPendingBatch(index, p);
    expect(index.pendingEmbeddingCount(p.profile)).toBe(0);
    expect(calls).toBe(4);
  } finally {
    index.close();
  }
});

function document(index: IndexDb, id: string, texts: string[], revision = 1) {
  index.replaceDocument({
    document_id: id,
    kb_id: "kb",
    revision,
    title: "Same title",
    labels: [],
    media_type: "text/plain",
    chunks: texts.map((text, ordinal) => ({ text, ordinal, heading_path: [], locator: null })),
  });
}

function provider(embed: EmbeddingProvider["embed"], batchSize = 100): EmbeddingProvider {
  return { provider: "ollama", model: "fixture", profile: "fixture", batchSize, embed };
}

test("shared batches deduplicate repeated inputs and reuse cached vectors across documents", async () => {
  const index = await IndexDb.open(":memory:");
  const calls: string[][] = [];
  const p = provider(async (texts) => {
    calls.push(texts);
    return texts.map(() => [1, 0]);
  });
  try {
    document(index, "one", ["same", "same", "different"]);
    expect(await embedPendingBatch(index, p)).toBe(3);
    expect(calls.map((c) => c.length)).toEqual([2]);
    expect(index.fullyEmbedded(p.profile, "one")).toBe(true);
    document(index, "two", ["same"]);
    await embedPendingBatch(index, p);
    expect(calls.length).toBe(1);
    expect(index.fullyEmbedded(p.profile, "two")).toBe(true);
  } finally {
    index.close();
  }
});

test("shared batches honor item count and UTF8 byte budget", async () => {
  const index = await IndexDb.open(":memory:");
  const calls: string[][] = [];
  const p = provider(async (texts) => {
    calls.push(texts);
    return texts.map(() => [1, 0]);
  }, 3);
  try {
    document(
      index,
      "doc",
      Array.from({ length: 5 }, (_, i) => `${i}${"א".repeat(24000)}`),
    );
    while (await embedPendingBatch(index, p)) {
      /* drain */
    }
    expect(calls.flat().length).toBe(5);
    expect(
      calls.every(
        (c) =>
          c.length <= p.batchSize &&
          c.reduce((n, t) => n + Buffer.byteLength(t), 0) <= EMBEDDING_BATCH_MAX_BYTES,
      ),
    ).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
  } finally {
    index.close();
  }
});

test("stale in-flight embeddings cannot attach to replacement chunks", async () => {
  const index = await IndexDb.open(":memory:");
  try {
    document(index, "doc", ["old"]);
    const p = provider(async () => {
      document(index, "doc", ["new"], 2);
      return [[1, 0]];
    });
    await embedPendingBatch(index, p);
    expect(index.pendingEmbeddings(p.profile, 10).map((c) => c.text)).toEqual(["new"]);
  } finally {
    index.close();
  }
});

test("a cached vector incompatible with the active profile is re-embedded", async () => {
  const index = await IndexDb.open(":memory:");
  let calls = 0;
  const p = provider(async (texts) => {
    calls++;
    return texts.map(() => [1, 0]);
  });
  try {
    document(index, "one", ["first"]);
    await embedPendingBatch(index, p);
    document(index, "two", ["second"]);
    const chunk = index.pendingEmbeddings(p.profile, 10)[0];
    if (!chunk) throw Error("Missing fixture");
    index.db.run("INSERT OR REPLACE INTO embed_cache(profile,input_hash,embedding) VALUES(?,?,?)", [
      p.profile,
      chunk.input_hash,
      encodeVector([1, 0, 0]),
    ]);
    await embedPendingBatch(index, p);
    expect(calls).toBe(2);
    expect(index.fullyEmbedded(p.profile, "two")).toBe(true);
  } finally {
    index.close();
  }
});
