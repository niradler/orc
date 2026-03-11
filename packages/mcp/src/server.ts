import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "@orc/core/logger";
import { executeTool, type ToolName, toolDefinitions } from "./tools.js";
import { zodToJsonSchema } from "./utils.js";

const logger = createLogger("mcp");

export function createMcpServer() {
  const server = new Server({ name: "orc", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logger.debug(`Tool call: ${name}`, args);

    try {
      const toolDef = toolDefinitions.find((t) => t.name === name);
      if (!toolDef) {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      const parsed = toolDef.inputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          content: [{ type: "text" as const, text: `Invalid args: ${parsed.error.message}` }],
          isError: true,
        };
      }

      const result = await executeTool(name as ToolName, parsed.data);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      logger.error(`Tool error: ${name}`, err);
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  });

  return server;
}

export async function startStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server running on stdio");
}
