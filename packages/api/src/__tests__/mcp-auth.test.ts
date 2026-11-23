import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { ChatStore } from "@orc/db/chat";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { Hono } from "hono";
import { mcpRouter } from "../routes/mcp.js";
import { createApp } from "../server.js";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
  app = createApp();
});

afterAll(() => {
  closeDb();
  resetConfig();
  delete process.env.ORC_API_SECRET;
  delete process.env.ORC_DB_PATH;
});

describe("MCP HTTP endpoint auth", () => {
  test("POST /mcp without a bearer token is rejected when a secret is set", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /mcp with a wrong bearer token is rejected", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer nope",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /mcp with the correct bearer token passes auth", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).not.toBe(401);
  });

  test("the mcpRouter sub-app enforces auth on its own (not just via parent)", async () => {
    // Mount the router in isolation to prove its own bearerAuth guards /mcp,
    // independent of the parent app's wildcard middleware.
    const isolated = new Hono();
    isolated.onError((err, c) => {
      const status = err instanceof OrcError ? err.statusCode : 500;
      return c.json({ error: err.message }, status as 401 | 500);
    });
    isolated.route("/", mcpRouter);
    const res = await isolated.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("MCP HTTP endpoint response body", () => {
  const rpc = (body: unknown) =>
    app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify(body),
    });

  test("initialize streams a JSON-RPC result back, not an empty body", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    const payload = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    expect(payload.id).toBe(1);
    expect(payload.result.serverInfo.name).toBe("orc");
  });
});

describe("MCP HTTP endpoint mode", () => {
  const rpc = (query: string, body: unknown) =>
    app.request(`/mcp${query}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify(body),
    });

  const listNames = async (query: string) => {
    const res = await rpc(query, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
    const text = await res.text();
    const payload = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return (payload.result.tools as { name: string }[]).map((t) => t.name);
  };

  test("?mode=meta lists only the meta tools", async () => {
    expect(await listNames("?mode=meta")).toEqual([
      "tool_search",
      "tool_describe",
      "tool_invoke",
      "tool_execute",
    ]);
  });

  test("meta executes JavaScript through the authenticated HTTP route", async () => {
    const res = await rpc("?mode=meta", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "tool_execute",
        arguments: { code: 'return (await tools.search("task")).tools.map(tool => tool.name);' },
      },
    });
    const text = await res.text();
    const payload = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    expect(payload.result.structuredContent.result).toContain("task_list");
  });

  test("bare /mcp defaults to meta discovery", async () => {
    const names = await listNames("");
    expect(names).toEqual(["tool_search", "tool_describe", "tool_invoke", "tool_execute"]);
  });

  test("explicit full mode lists the real tools", async () => {
    const names = await listNames("?mode=full");
    expect(names).toContain("memory_list");
    expect(names).not.toContain("tool_search");
  });

  test("a conversation-bound connection also lists speak, an unbound one never does", async () => {
    expect(await listNames("?mode=meta&session=thread-1")).toEqual([
      "tool_search",
      "tool_describe",
      "tool_invoke",
      "tool_execute",
      "speak",
    ]);
    expect(await listNames("?mode=full&session=thread-1")).toContain("speak");
    expect(await listNames("?mode=full")).not.toContain("speak");
  });

  test("an unknown mode is rejected with 400 naming the valid values", async () => {
    const res = await rpc("?mode=bogus", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("full, meta");
  });

  test("should withhold execution on anonymous HTTP, including direct calls by name", async () => {
    const previous = process.env.ORC_API_SECRET;
    process.env.ORC_API_SECRET = "";
    resetConfig();
    try {
      expect(await listNames("?mode=meta")).toEqual([
        "tool_search",
        "tool_describe",
        "tool_invoke",
      ]);
      const response = await rpc("?mode=meta", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "tool_execute", arguments: { code: "return 42;" } },
      });
      expect(await response.text()).toContain("Script execution is unavailable");
    } finally {
      if (previous === undefined) delete process.env.ORC_API_SECRET;
      else process.env.ORC_API_SECRET = previous;
      resetConfig();
    }
  });
});

describe("MCP HTTP session caller identity and code mode integration", () => {
  test("propagates bound session identity into direct and sandboxed session_list/session_send, enforces ancestry, and falls back to human relay only for unbound queue", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.fetch,
    });
    const previousBase = process.env.ORC_API_BASE;
    process.env.ORC_API_BASE = String(server.url).replace(/\/$/, "");
    resetConfig();

    const chats = new ChatStore(getSqlite());
    const now = Date.now();
    const baseConfig = {
      agent: "opencode" as const,
      model: "",
      models: [],
      permissionMode: "default" as const,
      sendWhileRunning: "queue" as const,
      autoApprove: false,
      mcp: "orc" as const,
      system: "",
      agentOptions: {},
    };
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const unrelatedId = crypto.randomUUID();
    chats.save({
      id: parentId,
      title: "Parent Chat",
      cwd: "/tmp/orc-521",
      host: null,
      backend: "opencode",
      runtimeId: "ses_parent_521",
      sourceId: null,
      config: baseConfig,
      messages: [],
      updatedAt: now,
    });
    chats.save({
      id: childId,
      title: "Child Worker",
      cwd: "/tmp/orc-521",
      host: null,
      backend: "opencode",
      runtimeId: "ses_child_521",
      sourceId: null,
      spawnedBy: { sessionId: parentId, notify: true, at: now },
      config: baseConfig,
      messages: [],
      updatedAt: now,
    });
    chats.save({
      id: unrelatedId,
      title: "Unrelated Chat",
      cwd: "/tmp/orc-521",
      host: null,
      backend: "opencode",
      runtimeId: "ses_other_521",
      sourceId: null,
      config: baseConfig,
      messages: [],
      updatedAt: now,
    });

    const callMcp = async (
      query: string,
      name: string,
      args: Record<string, unknown>,
      extraHeaders: Record<string, string> = {},
    ) => {
      const res = await app.request(`/mcp${query}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer test-secret",
          ...extraHeaders,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      expect(res.status).toBe(200);
      const raw = await res.text();
      return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)).result as {
        content: { text: string }[];
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      };
    };

    try {
      const listedViaQuery = await callMcp(`?mode=meta&session=${parentId}`, "session_list", {});
      expect(listedViaQuery.isError).toBeUndefined();
      expect(JSON.parse(listedViaQuery.content[0]?.text ?? "{}").sessions).toMatchObject([
        { session_id: childId },
      ]);

      const listedViaHeader = await callMcp(
        "?mode=meta",
        "session_list",
        {},
        {
          "X-ORC-Session": parentId,
        },
      );
      expect(listedViaHeader.isError).toBeUndefined();
      expect(JSON.parse(listedViaHeader.content[0]?.text ?? "{}").sessions).toMatchObject([
        { session_id: childId },
      ]);

      const directSend = await callMcp(`?mode=meta&session=${parentId}`, "session_send", {
        session_id: childId,
        mode: "queue",
        body: "Direct bound message",
      });
      expect(directSend.isError).toBeUndefined();
      expect(JSON.parse(directSend.content[0]?.text ?? "{}").message).toMatchObject({
        sender_kind: "session",
        sender_session_id: parentId,
        sender_native_id: "ses_parent_521",
        sender_backend: "opencode",
      });

      const directSteerAllowed = await callMcp(
        "?mode=meta",
        "session_send",
        {
          session_id: childId,
          mode: "steer",
          body: "Ancestor steer",
        },
        { "X-ORC-Session": parentId },
      );
      expect(directSteerAllowed.isError).toBeUndefined();
      expect(JSON.parse(directSteerAllowed.content[0]?.text ?? "{}").message).toMatchObject({
        sender_kind: "session",
        sender_session_id: parentId,
      });

      const nonAncestorSteer = await callMcp(`?mode=meta&session=${unrelatedId}`, "session_send", {
        session_id: childId,
        mode: "steer",
        body: "Not an ancestor",
      });
      expect(nonAncestorSteer.isError).toBe(true);
      expect(nonAncestorSteer.content[0]?.text).toContain("Only the session that started");

      const unboundQueue = await callMcp("?mode=meta", "session_send", {
        session_id: childId,
        mode: "queue",
        body: "Unbound relay queue",
      });
      expect(unboundQueue.isError).toBeUndefined();
      expect(JSON.parse(unboundQueue.content[0]?.text ?? "{}").message).toMatchObject({
        sender_kind: "human",
        sender_session_id: null,
      });

      const unboundSteer = await callMcp("?mode=meta", "session_send", {
        session_id: childId,
        mode: "steer",
        body: "Unbound steer must fail",
      });
      expect(unboundSteer.isError).toBe(true);
      expect(unboundSteer.content[0]?.text).toContain("requires a bound calling session identity");

      const scriptedBound = await callMcp(
        "?mode=meta",
        "tool_execute",
        {
          code: `
            const [list, sent] = await tools.allSettled([
              { name: "session_list", args: {} },
              { name: "session_send", args: { session_id: ${JSON.stringify(childId)}, mode: "queue", body: "From sandbox" } },
            ]);
            return {
              listOk: list.ok,
              children: list.ok ? list.data.sessions.map((s) => s.session_id) : [],
              sentOk: sent.ok,
              sender: sent.ok ? tools.pick(sent.data.message, ["sender_kind", "sender_session_id", "sender_native_id", "sender_backend"]) : null,
            };
          `,
        },
        { "X-ORC-Session": parentId },
      );
      expect(scriptedBound.isError).toBeUndefined();
      expect(scriptedBound.structuredContent?.result).toEqual({
        listOk: true,
        children: [childId],
        sentOk: true,
        sender: {
          sender_kind: "session",
          sender_session_id: parentId,
          sender_native_id: "ses_parent_521",
          sender_backend: "opencode",
        },
      });

      const scriptedUnbound = await callMcp("?mode=meta", "tool_execute", {
        code: `
          const [queued, steered] = await tools.allSettled([
            { name: "session_send", args: { session_id: ${JSON.stringify(childId)}, mode: "queue", body: "Sandbox unbound queue" } },
            { name: "session_send", args: { session_id: ${JSON.stringify(childId)}, mode: "steer", body: "Sandbox unbound steer" } },
          ]);
          return {
            queuedKind: queued.ok ? queued.data.message.sender_kind : null,
            steeredOk: steered.ok,
            steeredCode: steered.ok ? null : steered.error.code,
          };
        `,
      });
      expect(scriptedUnbound.isError).toBeUndefined();
      expect(scriptedUnbound.structuredContent?.result).toEqual({
        queuedKind: "human",
        steeredOk: false,
        steeredCode: "FORBIDDEN",
      });
    } finally {
      server.stop(true);
      if (previousBase === undefined) delete process.env.ORC_API_BASE;
      else process.env.ORC_API_BASE = previousBase;
      resetConfig();
    }
  });
});
