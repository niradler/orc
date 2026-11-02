import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, resetConfig } from "@orc/core/config";
import { DEFAULT_MCP_PROMPTS } from "@orc/core/mcp-prompts";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { McpPromptStore } from "@orc/db/mcp-prompts";
import { z } from "zod";
import { createMcpServer } from "../server.js";
import { toolDefinitions } from "../tools.js";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
});

afterAll(() => {
  closeDb();
  resetConfig();
  delete process.env.ORC_DB_PATH;
});

async function connect(mode?: "meta" | "full") {
  const server = createMcpServer(mode ? { mode } : {});
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (res: unknown) => (res as { content: { text: string }[] }).content[0]?.text ?? "";

test("should use configured defaults for native MCP connections and keep explicit overrides", async () => {
  const original = loadConfig().mcp;
  const clients: Client[] = [];
  try {
    loadConfig({ mcp: { ...original, default_mode: "full" } });
    const full = await connect();
    clients.push(full);
    expect((await full.listTools()).tools.map((tool) => tool.name)).not.toContain("ui_catalog");
    const meta = await connect("meta");
    clients.push(meta);
    expect((await meta.listTools()).tools.map((tool) => tool.name)).toEqual([
      "tool_search",
      "tool_describe",
      "tool_invoke",
    ]);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    loadConfig({ mcp: original });
  }
});

test("built-in prompts are seeded into the DB and served with a request argument", async () => {
  const client = await connect();
  const { prompts } = await client.listPrompts();
  expect(prompts.map((prompt) => prompt.name)).toEqual(DEFAULT_MCP_PROMPTS.map((p) => p.name));
  expect(prompts.map((prompt) => prompt.name)).toEqual(
    expect.arrayContaining([
      "render-ui",
      "create-task",
      "scratchpad",
      "memory",
      "kb",
      "skill",
      "need-attention",
      "agents",
    ]),
  );
  expect(prompts[0]?.arguments).toEqual([
    { name: "request", description: "What you need, in your own words", required: false },
  ]);
  const ui = JSON.stringify(
    await client.getPrompt({ name: "render-ui", arguments: { request: "my open tasks" } }),
  );
  expect(ui).toContain("# ORC chat UI components");
  expect(ui).toContain("my open tasks");
  const task = JSON.stringify(await client.getPrompt({ name: "create-task" }));
  expect(task).toContain("task_create");
  expect(task).toContain("ask what is needed");
  await expect(
    client.getPrompt({ name: "create-task", arguments: { other: "x" } }),
  ).rejects.toThrow('only the "request" argument');
  const attention = JSON.stringify(
    await client.getPrompt({ name: "need-attention", arguments: { request: "sudo apt upgrade" } }),
  );
  expect(attention).toContain("command_request");
  expect(attention).toContain("human_request_get");
  expect(attention).toContain("sudo apt upgrade");
  await client.close();
});

test("built-in prompts only name real tools, arguments and argument values", () => {
  const known = new Set(
    toolDefinitions.flatMap((tool) => [
      tool.name,
      ...[
        ...JSON.stringify(
          z.toJSONSchema(tool.inputSchema, { io: "input", unrepresentable: "any" }),
        ).matchAll(/"(\w+)"/g),
      ].map((match) => match[1]),
    ]),
  );
  for (const prompt of DEFAULT_MCP_PROMPTS) {
    const names = prompt.content.replace(/\{\{\w+\}\}/g, "").match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
    expect({ prompt: prompt.name, unknown: names.filter((name) => !known.has(name)) }).toEqual({
      prompt: prompt.name,
      unknown: [],
    });
  }
});

test("edited prompts are served from the store and deletions stick", async () => {
  const store = new McpPromptStore(getSqlite());
  const original = store.list();
  const client = await connect();
  try {
    store.replace([
      { name: "triage", title: "Triage", description: "", content: "Sort {{request}}" },
    ]);
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(["triage"]);
    expect(
      JSON.stringify(await client.getPrompt({ name: "triage", arguments: { request: "bugs" } })),
    ).toContain("Sort bugs");
    await expect(client.getPrompt({ name: "render-ui" })).rejects.toThrow("Unknown prompt");
  } finally {
    store.replace(original);
    await client.close();
  }
});

test("the UI catalog is neither a resource nor a tool", async () => {
  const client = await connect("full");
  await expect(client.listResources()).rejects.toThrow();
  const found = textOf(
    await (await connect()).callTool({
      name: "tool_search",
      arguments: { query: "render ui components chat catalog" },
    }),
  );
  expect(found).not.toContain("ui_catalog:");
  await client.close();
});
