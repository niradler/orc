import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { GatewayMode } from "@orc/core/types";
import { backendFromMode, handleDirectCommand, parseMemAdd } from "../direct.js";

describe("backendFromMode", () => {
  it("returns backend name for agent: prefix", () => {
    expect(backendFromMode("agent:claude")).toBe("claude");
    expect(backendFromMode("agent:acpx")).toBe("acpx");
    expect(backendFromMode("agent:a2a")).toBe("a2a");
    expect(backendFromMode("agent:gemini")).toBe("gemini");
  });

  it("returns claude for non-agent modes", () => {
    expect(backendFromMode("direct")).toBe("claude");
    expect(backendFromMode("multi")).toBe("claude");
  });

  it("returns claude for job: modes (not a backend)", () => {
    // job: modes are valid GatewayMode but should not extract a backend
    expect(backendFromMode("job:build" as GatewayMode)).toBe("claude");
    expect(backendFromMode("job:deploy" as GatewayMode)).toBe("claude");
  });

  it("returns claude for bare agent: with no suffix", () => {
    expect(backendFromMode("agent:" as GatewayMode)).toBe("claude");
  });
});

describe("parseMemAdd", () => {
  it("splits name, description and multi-line content", () => {
    expect(parseMemAdd("api-port Port the API uses | listens on 7700\nnot 7711")).toEqual({
      name: "api-port",
      description: "Port the API uses",
      content: "listens on 7700\nnot 7711",
    });
  });

  it("rejects input without a description or content", () => {
    expect(parseMemAdd("api-port | content")).toBeNull();
    expect(parseMemAdd("api-port description |  ")).toBeNull();
    expect(parseMemAdd("api-port description only")).toBeNull();
  });
});

describe("/mem", () => {
  const realFetch = globalThis.fetch;
  const requests: { method: string; url: URL; body: unknown }[] = [];

  beforeEach(() => {
    requests.length = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method ?? "GET", url, body });
      const memory = {
        project_id: "p1",
        name: "api-port",
        description: "Port <api>",
        content: "listens on 7700",
        priority: 80,
        author: "gateway",
        session_id: null,
        created_at: 1,
        updated_at: 1,
      };
      if (url.pathname === "/api/memories" && init?.method === "GET")
        return Response.json({ memories: [memory], total: 3 });
      if (url.pathname === "/api/memories/missing")
        return Response.json(
          { error: "Memory not found: missing", code: "NOT_FOUND" },
          { status: 404 },
        );
      if (url.pathname === "/api/memories/api-port") return Response.json(memory);
      if (url.pathname === "/api/memories") return Response.json(memory, { status: 201 });
      return Response.json({ error: "unexpected", code: "UNEXPECTED" }, { status: 500 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const run = (rawText: string, currentProjectId: string | null = "p1") =>
    handleDirectCommand({ chatKey: "test:1", rawText, currentProjectId });

  it("needs an active project", async () => {
    expect(await run("/mem", null)).toEqual({
      text: "Memories belong to a project. Set one first: /project <name>",
    });
    expect(requests).toHaveLength(0);
  });

  it("lists the project's memories with an optional query", async () => {
    const result = await run("/mem list port");
    expect(requests[0]?.url.searchParams.get("project_id")).toBe("p1");
    expect(requests[0]?.url.searchParams.get("q")).toBe("port");
    expect(result?.html).toContain("(1 of 3)");
    expect(result?.html).toContain("<code>api-port</code> [p80] - Port &lt;api&gt;");
    await run("/mem deploy");
    expect(requests[1]?.url.searchParams.get("q")).toBe("deploy");
  });

  it("shows a memory by name and reports missing ones", async () => {
    const result = await run("/mem show api-port");
    expect(requests[0]?.url.pathname).toBe("/api/memories/api-port");
    expect(result?.html).toContain("listens on 7700");
    expect(await run("/mem show missing")).toEqual({ text: "Memory not found: missing" });
  });

  it("adds a memory to the active project as the gateway", async () => {
    const result = await run("/mem add api-port Port the API uses | listens on 7700");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.body).toEqual({
      project_id: "p1",
      name: "api-port",
      description: "Port the API uses",
      content: "listens on 7700",
      author: "gateway",
    });
    expect(result).toEqual({ text: "Stored memory api-port" });
  });
});
