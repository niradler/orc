import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@orc/mcp";
import { Hono } from "hono";

const app = new Hono();

// Stateless mode: the SDK's WebStandardStreamableHTTPServerTransport explicitly
// rejects reuse when sessionIdGenerator is unset, so we create a fresh
// server+transport pair per request. This is the pattern recommended in the
// SDK docs for stateless HTTP MCP.
app.all("/mcp", async (c) => {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({});
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export { app as mcpRouter };
