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
  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } finally {
    // Stateless per-request server: release SDK-held resources/timers so they
    // don't accumulate under load or on aborted connections.
    void server.close().catch((err) => logger.warn("mcp server close failed", err));
    void transport.close().catch(() => {});
  }
});

export { app as mcpRouter };
