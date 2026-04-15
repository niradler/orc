import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { createApp } from "../server.js";
import { setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const AUTH = { Authorization: "Bearer test-secret", "content-type": "application/json" };

beforeAll(() => {
  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
});

/**
 * These tests exercise /chat/stream without shelling out to a real LLM.
 *
 * The happy-path round-trip (spawn acpx -> stdin flush -> stdout -> SSE) is
 * covered by the Playwright e2e spec in packages/web/tests/e2e/chat.spec.ts,
 * which is the only place where spawning a real agent makes sense.
 *
 * Here we lock down the input-validation contract so a broken client cannot
 * spawn an agent with an empty or malformed prompt.
 */
describe("/chat/stream contract", () => {
  test("rejects empty messages array with 400", async () => {
    const res = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/messages/i);
  });

  test("rejects missing messages field with 400", async () => {
    const res = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ agent: "claude" }),
    });
    expect(res.status).toBe(400);
  });
});
