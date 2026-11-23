import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb } from "@orc/db/client";
import { parseMcpMode, searchTools } from "../meta-tools.js";
import { createMcpServer } from "../server.js";
import { specToolDefinitions } from "../spec-tools.js";
import { toolDefinitions } from "../tools.js";

const originalActiveProject = process.env.ORC_ACTIVE_PROJECT;

beforeAll(() => {
  process.env.ORC_ACTIVE_PROJECT = "";
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
});

afterAll(() => {
  if (originalActiveProject === undefined) delete process.env.ORC_ACTIVE_PROJECT;
  else process.env.ORC_ACTIVE_PROJECT = originalActiveProject;
  closeDb();
  resetConfig();
  delete process.env.ORC_API_SECRET;
  delete process.env.ORC_DB_PATH;
});

async function connect(mode?: "full" | "meta") {
  const server = createMcpServer(mode ? { mode } : {});
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (res: unknown) =>
  ((res as { content: { text: string }[] }).content[0] as { text: string }).text;

describe("meta mode", () => {
  test("lists shared discovery, direct invocation and execution", async () => {
    const client = await connect("meta");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "tool_search",
      "tool_describe",
      "tool_invoke",
      "tool_execute",
    ]);
  });

  test("default mode uses the unified meta surface", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "tool_search",
      "tool_describe",
      "tool_invoke",
      "tool_execute",
    ]);
  });

  test("tool_search finds memory_list with a one-line description", async () => {
    const client = await connect("meta");
    const res = await client.callTool({ name: "tool_search", arguments: { query: "MEMORY_LIST" } });
    const text = textOf(res);
    expect(text).toContain("memory_list:");
    expect(text).toContain("tool_describe");
  });

  test("tool_search ranks name matches above description matches and honours limit", async () => {
    const client = await connect("meta");
    const res = await client.callTool({
      name: "tool_search",
      arguments: { query: "memory", limit: 2 },
    });
    const lines = textOf(res).split("\n\n")[0]?.split("\n");
    expect(lines?.length).toBe(2);
    for (const line of lines ?? []) expect(line.split(":")[0]).toContain("memory");
  });

  test("searchTools ranks multi-word and natural-language queries by term relevance", () => {
    const top = (query: string) => searchTools(toolDefinitions, query, 5)[0]?.name;
    expect(top("create task")).toBe("task_create");
    expect(top("task create")).toBe("task_create");
    expect(top("run job")).toBe("job_run");
    expect(top("save a fact")).toBe("memory_create");
    expect(top("search the kb")).toBe("kb_search");
    expect(top("report flow progress")).toBe("flow_report");
    expect(top("MEMORY_LIST")).toBe("memory_list");
    expect(searchTools(toolDefinitions, "tasks", 5).map((t) => t.name)).toContain("task_list");
    expect(searchTools(toolDefinitions, "zzz qqq", 5)).toEqual([]);
  });

  test("tool_search with an empty query returns available tools and hides unbound preview capabilities", async () => {
    const client = await connect("meta");
    for (const args of [{}, { query: "  " }, { query: "the a" }]) {
      const text = textOf(await client.callTool({ name: "tool_search", arguments: args }));
      const available = [...toolDefinitions, ...specToolDefinitions].filter(
        (tool) => !tool.name.startsWith("preview_") && tool.name !== "speak",
      );
      expect(text).toStartWith(`${available.length} tools by toolset:`);
      expect(text).toMatch(/^memory \(\d+\): .*memory_list/m);
      expect(text).toMatch(/^core \(\d+\): .*\bcontext\b/m);
      for (const tool of available) expect(text).toContain(tool.name);
      for (const tool of toolDefinitions.filter((tool) => tool.name.startsWith("preview_")))
        expect(text).not.toContain(tool.name);
      expect(text).not.toMatch(/\bspeak\b/);
    }
  });

  test("tool_describe returns the description and input schema", async () => {
    const client = await connect("meta");
    const res = await client.callTool({
      name: "tool_describe",
      arguments: { name: "memory_list" },
    });
    const body = JSON.parse(textOf(res));
    expect(body.name).toBe("memory_list");
    expect(body.inputSchema.type).toBe("object");
  });

  test("tool_describe on an unknown name errors with close names from the active catalog only", async () => {
    const client = await connect("meta");
    const res = await client.callTool({ name: "tool_describe", arguments: { name: "memory" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("memory_list");
    expect(textOf(res)).not.toContain("tool_execute");

    const bogus = await client.callTool({
      name: "tool_describe",
      arguments: { name: "tools.orc.tool_execute" },
    });
    expect(bogus.isError).toBe(true);
    const bogusText = textOf(bogus);
    expect(bogusText).toContain("Unknown tool: tools.orc.tool_execute.");
    const suggested =
      bogusText
        .split("Close names:")[1]
        ?.split(",")
        .map((s) => s.trim()) ?? [];
    const catalog = new Set<string>(
      [...toolDefinitions, ...specToolDefinitions]
        .filter((tool) => !tool.name.startsWith("preview_") && tool.name !== "speak")
        .map((tool) => tool.name),
    );
    for (const suggestion of suggested) {
      expect(catalog.has(suggestion)).toBe(true);
      expect(suggestion).not.toContain("tool_execute");
    }

    const hidden = await client.callTool({
      name: "tool_describe",
      arguments: { name: "speak" },
    });
    expect(hidden.isError).toBe(true);
    expect(textOf(hidden)).not.toContain("Close names: speak");
  });

  test("tool_invoke runs a real tool", async () => {
    const client = await connect("meta");
    const res = await client.callTool({
      name: "tool_invoke",
      arguments: { name: "project_list", arguments: {} },
    });
    expect(res.isError).not.toBe(true);
  });

  test("tool_invoke with invalid args matches the direct-call error", async () => {
    const meta = await connect("meta");
    const full = await connect("full");
    const bad = { limit: "not-a-number" };
    const direct = await full.callTool({ name: "memory_list", arguments: bad });
    const viaMeta = await meta.callTool({
      name: "tool_invoke",
      arguments: { name: "memory_list", arguments: bad },
    });
    expect(direct.isError).toBe(true);
    expect(textOf(direct)).toStartWith("Invalid args:");
    expect(viaMeta).toEqual(direct);
  });

  test("tool_invoke with an unknown name errors", async () => {
    const client = await connect("meta");
    const res = await client.callTool({ name: "tool_invoke", arguments: { name: "nope" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Unknown tool: nope");
  });

  test("tool_invoke cannot reach the meta tools themselves", async () => {
    const client = await connect("meta");
    const res = await client.callTool({ name: "tool_invoke", arguments: { name: "tool_invoke" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("Unknown tool: tool_invoke");
  });

  test("a direct CallTool of a real tool still works in meta mode", async () => {
    const client = await connect("meta");
    const res = await client.callTool({ name: "project_list", arguments: {} });
    expect(res.isError).not.toBe(true);
  });

  test("meta tool names are not callable in full mode", async () => {
    const client = await connect("full");
    const res = await client.callTool({ name: "tool_search", arguments: {} });
    expect(res.isError).toBe(true);
  });
});

describe("parseMcpMode", () => {
  test("defaults to meta, accepts full, rejects others", () => {
    expect(parseMcpMode(undefined)).toBe("meta");
    expect(parseMcpMode("full")).toBe("full");
    expect(parseMcpMode("meta")).toBe("meta");
    expect(() => parseMcpMode("code")).toThrow("Valid modes: full, meta");
    expect(() => parseMcpMode("bogus")).toThrow("Valid modes: full, meta");
  });
});
