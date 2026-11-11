import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { createApp } from "../server.js";
import { setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const oldMock = process.env.ORC_E2E_CHAT_MOCK;
const AUTH = {
  Authorization: "Bearer test-secret",
  "content-type": "application/json",
};

beforeAll(() => {
  process.env.ORC_E2E_CHAT_MOCK = "1";
  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
  if (oldMock === undefined) delete process.env.ORC_E2E_CHAT_MOCK;
  else process.env.ORC_E2E_CHAT_MOCK = oldMock;
});

function expectUnbuffered(res: Response) {
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(res.headers.get("x-accel-buffering")).toBe("no");
}

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

describe("/chat SSE proxy buffering", () => {
  test("should disable proxy buffering on the turn stream and the live reattach stream", async () => {
    const res = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ messages: [{ role: "user", content: "reply after 1000ms" }] }),
    });
    expect(res.status).toBe(200);
    expectUnbuffered(res);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No stream");
    let text = "";
    const decoder = new TextDecoder();
    let threadId: string | undefined;
    while (!threadId) {
      const part = await reader.read();
      if (part.done) throw new Error("Stream ended before the thread was announced");
      text += decoder.decode(part.value);
      for (const line of text.split("\n").filter((l) => l.startsWith("data:"))) {
        const event = JSON.parse(line.slice(5)) as { type: string; thread?: { id: string } };
        if (event.type === "thread") threadId = event.thread?.id;
      }
    }
    const live = await app.request(`/api/chat/threads/${threadId}/live`, { headers: AUTH });
    expect(live.status).toBe(200);
    expectUnbuffered(live);
    await live.body?.cancel();
    while (!(await reader.read()).done) {}
  });
});
