import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CHAT_UI_CATALOG_URI, chatUiCatalogText } from "@orc/core/chat-ui";
import { loadConfig, resetConfig } from "@orc/core/config";
import { closeDb, createTestDb } from "@orc/db/client";
import { createMcpServer } from "../server.js";

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
    expect((await full.listTools()).tools.map((tool) => tool.name)).toContain("ui_catalog");
    const meta = await connect("meta");
    clients.push(meta);
    expect((await meta.listTools()).tools.map((tool) => tool.name)).toEqual([
      "tool_search",
      "tool_describe",
      "tool_invoke",
    ]);
    expect((await full.listPrompts()).prompts.map((prompt) => prompt.name)).toContain("render-ui");
    const prompt = await full.getPrompt({ name: "render-ui" });
    expect(JSON.stringify(prompt)).toContain("# ORC chat UI components");
    loadConfig({ mcp: { ...original, prompts: [] } });
    expect((await full.listPrompts()).prompts).toEqual([]);
    await expect(full.getPrompt({ name: "render-ui" })).rejects.toThrow("Unknown prompt");
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    loadConfig({ mcp: original });
  }
});

test("the UI catalog is a readable resource", async () => {
  const client = await connect();
  const { resources } = await client.listResources();
  expect(resources).toEqual([
    expect.objectContaining({ uri: CHAT_UI_CATALOG_URI, name: "ui_catalog" }),
  ]);
  const { contents } = await client.readResource({ uri: CHAT_UI_CATALOG_URI });
  expect(contents).toEqual([
    { uri: CHAT_UI_CATALOG_URI, mimeType: "text/markdown", text: chatUiCatalogText() },
  ]);
  expect(client.readResource({ uri: "orc://ui/other" })).rejects.toThrow("Unknown resource");
});

test("meta-mode agents find and read the same catalog through tools", async () => {
  const client = await connect();
  const found = textOf(
    await client.callTool({
      name: "tool_search",
      arguments: { query: "render ui components chat" },
    }),
  );
  expect(found).toContain("ui_catalog:");
  const text = textOf(
    await client.callTool({
      name: "tool_invoke",
      arguments: { name: "ui_catalog", arguments: {} },
    }),
  );
  expect(text).toBe(chatUiCatalogText());
  expect(text).toContain("webchat");
});
