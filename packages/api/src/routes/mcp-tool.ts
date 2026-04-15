import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ValidationError } from "@orc/core/errors";
import { executeTool, toolDefinitions } from "@orc/mcp/tools";

const app = new OpenAPIHono();

const mcpToolRoute = createRoute({
  method: "post",
  path: "/mcp/tool",
  tags: ["MCP"],
  summary: "Execute an MCP tool by name - used by hook scripts",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              name: z.string().min(1),
              args: z.record(z.unknown()).optional().default({}),
            })
            .openapi("McpToolCall"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Tool result",
      content: {
        "application/json": {
          schema: z.object({ result: z.string() }).openapi("McpToolResult"),
        },
      },
    },
  },
});

app.openapi(mcpToolRoute, async (c) => {
  const { name, args } = c.req.valid("json");

  const toolDef = toolDefinitions.find((t) => t.name === name);
  if (!toolDef) throw new ValidationError(`Unknown MCP tool: ${name}`);

  const parsed = toolDef.inputSchema.safeParse(args ?? {});
  if (!parsed.success) throw new ValidationError(`Invalid args: ${parsed.error.message}`);

  const result = await executeTool(name as Parameters<typeof executeTool>[0], parsed.data);
  return c.json({ result });
});

export { app as mcpToolRouter };
