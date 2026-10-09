import { expect, test } from "bun:test";
import { configuredEmbeddingProvider } from "./embedding-provider.js";

test("should use an explicitly configured local provider and reject hosted calls, redirects and malformed vectors", async () => {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      calls++;
      if (new URL(request.url).pathname === "/redirect")
        return Response.redirect("https://example.com/embeddings");
      const body = (await request.json()) as { model: string; input: string[] };
      expect(body.model).toBe("local-test");
      if (new URL(request.url).pathname === "/bad")
        return Response.json({ data: [{ index: 0, embedding: [1] }] });
      return Response.json({
        data: body.input.map((_, index) => ({ index, embedding: [index + 1, 1] })).reverse(),
      });
    },
  });
  const settings = {
    endpoint: `http://127.0.0.1:${server.port}/embeddings`,
    model: "local-test",
    dimensions: 2,
    allow_hosted: false,
    timeout_ms: 1000,
  };
  try {
    expect(await configuredEmbeddingProvider(settings)?.embed(["original", "evidence"])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    await expect(
      configuredEmbeddingProvider({
        ...settings,
        endpoint: "https://example.com/embeddings",
      })?.embed(["private"]),
    ).rejects.toThrow("allow_hosted");
    expect(calls).toBe(1);
    await expect(
      configuredEmbeddingProvider({
        ...settings,
        endpoint: `http://127.0.0.1:${server.port}/redirect`,
      })?.embed(["private"]),
    ).rejects.toThrow();
    await expect(
      configuredEmbeddingProvider({
        ...settings,
        endpoint: `http://127.0.0.1:${server.port}/bad`,
      })?.embed(["private"]),
    ).rejects.toThrow("vectors");
  } finally {
    await server.stop(true);
  }
});
