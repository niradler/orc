import { afterAll, beforeAll, expect, test } from "bun:test";
import type { createApp } from "../server.js";
import { setupTestApp, teardownTestApp } from "./helpers.js";

const UNDOCUMENTED = ["ALL /mcp", "GET /docs", "GET /openapi.json"];

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(() => {
  teardownTestApp();
});

test("should document every registered route with a typed success response", async () => {
  const response = await app.request("/openapi.json", {
    headers: { Authorization: "Bearer test-secret" },
  });
  const spec = (await response.json()) as {
    paths: Record<string, Record<string, { responses?: Record<string, { content?: unknown }> }>>;
  };
  const documented = new Set(
    Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map(
        (method) => `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`,
      ),
    ),
  );
  const missing = [
    ...new Set(
      app.routes
        .filter((route) => route.method !== "ALL" || route.path.endsWith("/mcp"))
        .map((route) => `${route.method} ${route.path}`),
    ),
  ].filter((route) => !documented.has(route));
  expect(missing.sort()).toEqual(UNDOCUMENTED);
  const untyped = Object.entries(spec.paths).flatMap(([path, ops]) =>
    Object.entries(ops)
      .filter(([, op]) =>
        Object.entries(op.responses ?? {}).some(
          ([status, res]) => status.startsWith("2") && status !== "204" && !res.content,
        ),
      )
      .map(([method]) => `${method.toUpperCase()} ${path}`),
  );
  expect(untyped).toEqual([]);
});
