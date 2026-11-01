import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CHAT_UI_CATALOG_URI, chatUiCatalogText } from "@orc/core/chat-ui";
import { resetConfig } from "@orc/core/config";
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

async function connect() {
  const server = createMcpServer();
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (res: unknown) => (res as { content: { text: string }[] }).content[0]?.text ?? "";

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
