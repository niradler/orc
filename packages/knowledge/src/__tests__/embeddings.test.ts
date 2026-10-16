import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createEmbeddingProvider, type EmbeddingConfig } from "../embeddings.js";

let server: ReturnType<typeof Bun.serve>;
const seen: { path: string; authorization: string | null }[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ path, authorization: req.headers.get("authorization") });
      const body = (await req.json()) as { input: string[] };
      const vectors = body.input.map(() => [0.1, 0.2, 0.3]);
      return Response.json(
        path === "/api/embed"
          ? { embeddings: vectors }
          : { data: vectors.map((embedding, index) => ({ index, embedding })) },
      );
    },
  });
});

afterAll(() => server.stop(true));

const config = (provider: "ollama" | "openai", api_key?: string): EmbeddingConfig =>
  ({
    provider,
    base_url: `http://127.0.0.1:${server.port}${provider === "openai" ? "/v1" : ""}`,
    model: "m",
    batch_size: 8,
    timeout_secs: 5,
    ...(api_key ? { api_key } : {}),
  }) as EmbeddingConfig;

describe("embedding providers", () => {
  test("send the configured token as a bearer header to Ollama and OpenAI-compatible APIs", async () => {
    for (const provider of ["ollama", "openai"] as const) {
      seen.length = 0;
      const p = createEmbeddingProvider(config(provider, "tok-1"));
      expect(await p?.embed(["a", "b"], "document")).toHaveLength(2);
      expect(seen[0]?.authorization).toBe("Bearer tok-1");
    }
  });

  test("send no authorization header without a token", async () => {
    seen.length = 0;
    await createEmbeddingProvider(config("ollama"))?.embed(["a"], "query");
    expect(seen[0]).toEqual({ path: "/api/embed", authorization: null });
  });
});
