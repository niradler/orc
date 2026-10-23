import { expect, test } from "bun:test";
import { createEmbeddingProvider, type EmbeddingConfig, EmbeddingError } from "../embeddings.js";

test.each([
  { status: 408, retryable: true },
  { status: 429, retryable: true },
  { status: 503, retryable: true },
  { status: 400, retryable: false },
  { status: 401, retryable: false },
])("classifies provider HTTP $status for bounded job retries", async ({ status, retryable }) => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("private response", { status }),
  });
  try {
    const provider = createEmbeddingProvider({
      provider: "ollama",
      model: "fixture",
      base_url: `http://127.0.0.1:${server.port}`,
      batch_size: 2,
      timeout_secs: 1,
    });
    try {
      await provider?.embed(["input"], "document");
      throw Error("Expected rejection");
    } catch (error) {
      if (!(error instanceof EmbeddingError)) throw error;
      expect(error.retryable).toBe(retryable);
      expect(error.message).not.toContain("private");
    }
  } finally {
    server.stop(true);
  }
});

async function providerResponse(
  provider: "ollama" | "openai",
  response: unknown,
  check: (cfg: EmbeddingConfig) => Promise<void>,
) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(response),
  });
  try {
    await check({
      provider,
      model: "fixture",
      base_url: `http://127.0.0.1:${server.port}`,
      batch_size: 8,
      timeout_secs: 5,
    });
  } finally {
    server.stop(true);
  }
}

for (const provider of ["ollama", "openai"] as const) {
  test.each(
    [
      [
        [1, "2"],
        [2, 1],
      ],
      [
        [1, null],
        [2, 1],
      ],
      [
        [0, 0],
        [2, 1],
      ],
      [
        [1, 2],
        [3, 4, 5],
      ],
      [
        [1e100, 1],
        [2, 1],
      ],
    ].map((vectors) => ({ vectors })),
  )(
    `${provider} refuses unusable vector components, norms and inconsistent dimensions: %j`,
    async ({ vectors }) => {
      const response =
        provider === "ollama"
          ? { embeddings: vectors }
          : { data: vectors.map((embedding, index) => ({ index, embedding })) };
      await providerResponse(provider, response, async (cfg) => {
        await expect(
          createEmbeddingProvider(cfg)?.embed(["first", "second"], "document"),
        ).rejects.toThrow();
      });
    },
  );
}

test.each(
  [
    [0, 0],
    [0, 2],
    [-1, 0],
    [0.5, 1],
  ].map((indices) => ({ indices })),
)("OpenAI refuses missing/duplicate input mappings: %j", async ({ indices }) => {
  await providerResponse(
    "openai",
    { data: indices.map((index) => ({ index, embedding: [1, 2] })) },
    async (cfg) => {
      await expect(
        createEmbeddingProvider(cfg)?.embed(["first", "second"], "document"),
      ).rejects.toThrow();
    },
  );
});

test("OpenAI reorders valid response indices to the original inputs", async () => {
  await providerResponse(
    "openai",
    {
      data: [
        { index: 1, embedding: [2, 1] },
        { index: 0, embedding: [1, 2] },
      ],
    },
    async (cfg) => {
      expect(await createEmbeddingProvider(cfg)?.embed(["first", "second"], "document")).toEqual([
        [1, 2],
        [2, 1],
      ]);
    },
  );
});

test("provider errors do not expose credentials or submitted document text", async () => {
  const secret = "private-provider-token";
  const content = "private-document-body";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(`${secret} ${content}`, { status: 400 }),
  });
  try {
    const provider = createEmbeddingProvider({
      provider: "openai",
      model: "fixture",
      base_url: `http://127.0.0.1:${server.port}`,
      api_key: secret,
      batch_size: 8,
      timeout_secs: 5,
    });
    let message = "";
    try {
      await provider?.embed([content], "document");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("400");
    expect(message).not.toContain(secret);
    expect(message).not.toContain(content);
  } finally {
    server.stop(true);
  }
});

test("Ollama uses task prefixes, batches inputs and refuses silent truncation", async () => {
  const bodies: { input: string[]; truncate: boolean }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { input: string[]; truncate: boolean };
      bodies.push(body);
      return Response.json({ embeddings: body.input.map(() => [1, 0]) });
    },
  });
  try {
    const provider = createEmbeddingProvider({
      provider: "ollama",
      model: "nomic-embed-text",
      base_url: `http://127.0.0.1:${server.port}`,
      batch_size: 8,
      timeout_secs: 5,
    });
    await provider?.embed(["first", "second"], "document");
    await provider?.embed(["question"], "query");
    expect(bodies.map((b) => b.input)).toEqual([
      ["search_document: first", "search_document: second"],
      ["search_query: question"],
    ]);
    expect(bodies.every((b) => b.truncate === false)).toBe(true);
  } finally {
    server.stop(true);
  }
});

test.each(
  [
    {
      model: "mxbai-embed-large:latest",
      query: "Represent this sentence for searching relevant passages: question",
    },
    {
      model: "qwen3-embedding:0.6b",
      query:
        "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: question",
    },
  ].flatMap((item) => (["ollama", "openai"] as const).map((provider) => ({ ...item, provider }))),
)(
  "$provider prepares retrieval queries for $model without changing document inputs",
  async ({ model, query, provider: kind }) => {
    const inputs: string[][] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { input: string[] };
        inputs.push(body.input);
        const vectors = body.input.map(() => [1, 0]);
        return Response.json(
          kind === "ollama"
            ? { embeddings: vectors }
            : { data: vectors.map((embedding, index) => ({ index, embedding })) },
        );
      },
    });
    try {
      const provider = createEmbeddingProvider({
        provider: kind,
        model,
        base_url: `http://127.0.0.1:${server.port}`,
        batch_size: 8,
        timeout_secs: 5,
      });
      await provider?.embed(["document"], "document");
      await provider?.embed(["question"], "query");
      expect(inputs).toEqual([["document"], [query]]);
    } finally {
      server.stop(true);
    }
  },
);
