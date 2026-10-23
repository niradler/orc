import { expect, test } from "bun:test";
import { IndexDb } from "../index-db.js";
import { cosineDistance, encodeVector } from "../vector.js";

test("native and fallback cosine search agree with scope filters and per-document caps", async () => {
  const index = await IndexDb.open(":memory:");
  try {
    for (const [doc, kb, vectors] of [
      [
        "one",
        "allowed",
        [
          [1, 0],
          [0.9, 0.1],
        ],
      ],
      ["two", "allowed", [[0.6, 0.4]]],
      ["private", "excluded", [[1, 0]]],
    ] as const) {
      index.replaceDocument({
        document_id: doc,
        kb_id: kb,
        revision: 1,
        title: doc,
        labels: ["fixture"],
        media_type: "text/plain",
        chunks: vectors.map((_, ordinal) => ({
          ordinal,
          text: `${doc} ${ordinal}`,
          heading_path: [],
          locator: null,
        })),
      });
      index.putVectors(
        "profile",
        index.pendingEmbeddings("profile", 10, doc).map((c, i) => ({
          chunk_id: c.id,
          hash: c.input_hash,
          vector: encodeVector(vectors[i] ?? []),
        })),
      );
    }
    const filter = { kb_ids: ["allowed"], labels: ["fixture"], media_types: ["text/plain"] };
    const native = index.semantic([1, 0], "profile", filter, 10, 1);
    index.backend = "exact-scan";
    const fallback = index.semantic([1, 0], "profile", filter, 10, 1);
    expect(native.map((h) => h.id)).toEqual(fallback.map((h) => h.id));
    expect(fallback.length).toBe(2);
    for (const [i, hit] of native.entries())
      expect(hit.distance).toBeCloseTo(fallback[i]?.distance ?? -1, 5);
    expect(index.getChunks(fallback.map((h) => h.id)).every((c) => c.kb_id === "allowed")).toBe(
      true,
    );
  } finally {
    index.close();
  }
});

test("cosine distance rejects incompatible vector spaces instead of comparing prefixes", () => {
  expect(() => cosineDistance(new Float32Array([1, 0]), new Float32Array([1, 0, 100]))).toThrow();
});

for (const backend of ["sqlite-vec", "exact-scan"] as const) {
  test(`${backend} rejects query dimension drift before ranking`, async () => {
    const index = await IndexDb.open(":memory:");
    try {
      if (backend === "sqlite-vec") expect(index.backend).toBe("sqlite-vec");
      else index.backend = backend;
      index.replaceDocument({
        document_id: "doc",
        kb_id: "kb",
        revision: 1,
        title: "Fixture",
        labels: [],
        media_type: "text/plain",
        chunks: [{ ordinal: 0, heading_path: [], locator: null, text: "Fixture passage" }],
      });
      const chunk = index.pendingEmbeddings("profile", 1)[0];
      if (!chunk) throw Error("Missing fixture chunk");
      index.putVectors("profile", [
        {
          chunk_id: chunk.id,
          hash: chunk.input_hash,
          vector: new Uint8Array(new Float32Array([1, 0, 1]).buffer),
        },
      ]);
      expect(() => index.semantic([1, 0], "profile", { kb_ids: ["kb"] }, 5)).toThrow();
      expect(() => index.semantic([0, 0, 0], "profile", { kb_ids: ["kb"] }, 5)).toThrow();
    } finally {
      index.close();
    }
  });
}

test("index rejects a mixed-dimension batch atomically before caching any vector", async () => {
  const index = await IndexDb.open(":memory:");
  try {
    expect(() =>
      index.putVectors("profile", [
        { chunk_id: 1, hash: "first", vector: new Uint8Array(new Float32Array([1, 0]).buffer) },
        { chunk_id: 2, hash: "second", vector: new Uint8Array(new Float32Array([1, 0, 1]).buffer) },
      ]),
    ).toThrow();
    expect(index.cachedEmbedding("profile", "first")).toBeNull();
  } finally {
    index.close();
  }
});

test.each(
  [
    [0, 0],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ].map((v) => ({ v })),
)("cosine distance rejects unusable vectors: %j", ({ v }) => {
  expect(() => cosineDistance(Float32Array.from(v), new Float32Array([1, 0]))).toThrow();
});
