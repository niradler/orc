// A stdio MCP server with one tool, resources, a resource template and prompts, for spec-cli tests.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "docs", version: "1.0.0" });
server.registerTool("ping", { description: "Ping" }, async () => ({
  content: [{ type: "text", text: "pong" }],
}));
server.registerResource(
  "readme",
  "docs://readme",
  { description: "The readme", mimeType: "text/markdown" },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Docs" }] }),
);
server.registerResource(
  "secret",
  "docs://secret",
  { description: "Hidden by a filter" },
  async (uri) => ({ contents: [{ uri: uri.href, text: "secret" }] }),
);
server.registerResource(
  "page",
  new ResourceTemplate("docs://pages/{slug}", { list: undefined }),
  { description: "A page by slug" },
  async (uri, { slug }) => ({ contents: [{ uri: uri.href, text: `page ${slug}` }] }),
);
server.registerPrompt(
  "summarize",
  { description: "Summarize a topic", argsSchema: { topic: z.string().describe("The topic") } },
  async ({ topic }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Summarize ${topic}` } }],
  }),
);
await server.connect(new StdioServerTransport());
