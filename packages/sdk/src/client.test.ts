import { afterAll, describe, expect, test } from "bun:test";
import { createOrcClient } from "./client.js";

describe("createOrcClient", () => {
  const client = createOrcClient({
    baseUrl: "http://localhost:0",
    secret: "test",
  });

  test("exposes resource namespaces", () => {
    expect(typeof client.tasks.list).toBe("function");
    expect(typeof client.memories.list).toBe("function");
    expect(typeof client.jobs.list).toBe("function");
    expect(typeof client.skills.list).toBe("function");
    expect(typeof client.projects.list).toBe("function");
    expect(typeof client.sessions.list).toBe("function");
    expect(typeof client.tags.list).toBe("function");
    expect(typeof client.health.check).toBe("function");
    expect(typeof client.gateway.status).toBe("function");
    expect(typeof client.kb.search).toBe("function");
  });

  test("returns network error when the API is unreachable", async () => {
    const result = await client.health.check();
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("NETWORK_ERROR");
  });
});

describe("memories", () => {
  type Seen = { method: string; path: string; query: string; source: string | null; body: unknown };
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      seen.push({
        method: req.method,
        path: url.pathname,
        query: url.search,
        source: req.headers.get("X-Orc-Source"),
        body: text ? JSON.parse(text) : undefined,
      });
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ ok: true });
    },
  });
  afterAll(() => server.stop(true));
  const memories = createOrcClient({
    baseUrl: `http://localhost:${server.port}`,
    source: "cli",
  }).memories;
  const last = () => seen.at(-1) as Seen;

  test("list sends filters as query params", async () => {
    await memories.list({ project_id: "p1", q: "port", sort: "priority", limit: 5 });
    expect(last()).toMatchObject({
      method: "GET",
      path: "/api/memories",
      query: "?project_id=p1&q=port&sort=priority&limit=5",
      source: "cli",
    });
  });

  test("get, history and delete address the memory by project and name", async () => {
    await memories.get("p1", "api-port");
    expect(last()).toMatchObject({
      method: "GET",
      path: "/api/memories/api-port",
      query: "?project_id=p1",
    });
    await memories.history("p1", "api-port");
    expect(last()).toMatchObject({
      path: "/api/memories/api-port/history",
      query: "?project_id=p1",
    });
    const res = await memories.delete("p1", "api-port", { author: "cli", session_id: "s1" });
    expect(res.error).toBeNull();
    expect(last()).toMatchObject({
      method: "DELETE",
      path: "/api/memories/api-port",
      query: "?project_id=p1&author=cli&session_id=s1",
    });
  });

  test("update and revert put project_id in the body", async () => {
    await memories.update("p1", "api-port", { priority: null, reason: "unscore" });
    expect(last()).toMatchObject({
      method: "PATCH",
      path: "/api/memories/api-port",
      body: { project_id: "p1", priority: null, reason: "unscore" },
    });
    await memories.revert("p1", "api-port", {
      change_id: "c1",
      expected_change_id: "c2",
      reason: "undo",
    });
    expect(last()).toMatchObject({
      method: "POST",
      path: "/api/memories/api-port/revert",
      body: { project_id: "p1", change_id: "c1", expected_change_id: "c2", reason: "undo" },
    });
  });
});
