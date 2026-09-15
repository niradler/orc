import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig } from "@orc/core/config";
import { createLogger } from "@orc/core/logger";
import { createMcpServer } from "@orc/mcp";
import { Hono } from "hono";
import { bearerAuth } from "../middleware/auth.js";

const logger = createLogger("api:mcp");

const app = new Hono();

// Defense-in-depth: the MCP HTTP endpoint exposes the full MCP tool surface
// (job execution, skill/file writes, knowledge indexing). Resolve the secret
// per-request (loadConfig is cached) so the guard reflects live config rather
// than whatever was set when this module was first imported.
app.use("/mcp", (c, next) => bearerAuth(loadConfig().api.secret)(c, next));

// Stateless mode: the SDK's WebStandardStreamableHTTPServerTransport explicitly
// rejects reuse when sessionIdGenerator is unset, so we create a fresh
// server+transport pair per request. This is the pattern recommended in the
// SDK docs for stateless HTTP MCP.
app.all("/mcp", async (c) => {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({});
  // handleRequest returns while the SSE body is still streaming, so the
  // per-request server is released on transport close, never in a finally.
  transport.onclose = () => {
    void server.close().catch((err) => logger.warn("mcp server close failed", err));
  };
  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } catch (err) {
    void server.close().catch(() => {});
    void transport.close().catch(() => {});
    throw err;
  }
});

export { app as mcpRouter };
