import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "@orc/core/logger";
import { z } from "zod";
import { normalizeMcpProjects, parseMcpProjects, resolveMcpProjects } from "./project-scope.js";

export { parseMcpProjects } from "./project-scope.js";

import {
  isMetaToolName,
  type McpMode,
  metaToolListing,
  runMetaTool,
  type ToolResult,
} from "./meta-tools.js";
import {
  agentSessionFromEnv,
  executeTool,
  type ToolName,
  type ToolOptions,
  toolDefinitions,
} from "./tools.js";

const logger = createLogger("mcp");

type ListedTool = (typeof toolDefinitions)[number];

function listing(tools: readonly ListedTool[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.inputSchema, {
      target: "draft-7",
      io: "input",
    }),
  }));
}

export function toolListing() {
  return listing(toolDefinitions);
}

export interface McpServerOptions extends ToolOptions {
  mode?: McpMode;
  project?: string;
  projects?: string[];
}

export function createMcpServer({
  mode = "full",
  project,
  projects,
  ...options
}: McpServerOptions = {}) {
  if (project !== undefined && projects !== undefined)
    throw new Error("Use project or projects, not both");
  const names = projects ? normalizeMcpProjects(projects) : parseMcpProjects(project);
  const selected = names ? resolveMcpProjects(names) : undefined;
  const server = new Server({ name: "orc", version: "0.0.1" }, { capabilities: { tools: {} } });

  // The set of tools this connection serves. Every lookup, listing and meta
  // search goes through it, so a future subset filter only changes this line.
  const served: readonly ListedTool[] = toolDefinitions;

  async function callTool(name: string, args: unknown): Promise<ToolResult> {
    logger.debug(`Tool call: ${name}`, name === "session_handoff" ? undefined : args);

    try {
      const toolDef = served.find((t) => t.name === name);
      if (!toolDef) {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      let scopedArgs = args ?? {};
      let callProjects = selected;
      if (selected && typeof scopedArgs === "object" && !Array.isArray(scopedArgs)) {
        const input = scopedArgs as Record<string, unknown>;
        const explicit = input.project !== undefined || input.project_id !== undefined;
        const chosen = selected.find(
          (candidate) =>
            (input.project === undefined ||
              (typeof input.project === "string" &&
                candidate.name.toLowerCase() === input.project.toLowerCase())) &&
            (input.project_id === undefined || candidate.id === input.project_id),
        );
        if (!chosen)
          throw new Error(
            `This MCP connection is scoped to projects ${selected.map((p) => p.name).join(", ")}`,
          );
        callProjects = explicit ? [chosen] : selected;
        scopedArgs =
          "project" in toolDef.inputSchema.shape
            ? { ...input, project: chosen.name }
            : { ...input };
        if (
          "project_id" in toolDef.inputSchema.shape &&
          !("project" in toolDef.inputSchema.shape) &&
          input.project_id === undefined
        )
          scopedArgs = { ...scopedArgs, project_id: chosen.id };
        if ("projects" in toolDef.inputSchema.shape) {
          const requested = input.projects;
          if (
            requested !== undefined &&
            (!Array.isArray(requested) ||
              requested.some(
                (value) =>
                  typeof value !== "string" ||
                  !selected.some((p) => p.name.toLowerCase() === value.toLowerCase()),
              ))
          )
            throw new Error("Projects must be selected in this MCP connection");
          scopedArgs = { ...scopedArgs, projects: requested ?? selected.map((p) => p.name) };
        }
      }
      const parsed = toolDef.inputSchema.safeParse(scopedArgs);
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Invalid args: ${parsed.error.message}`,
            },
          ],
          isError: true,
        };
      }

      const result = await executeTool(name as ToolName, parsed.data, {
        ...options,
        ...(callProjects ? { projectScopes: callProjects } : {}),
      });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      logger.error(`Tool error: ${name}`, err);
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mode === "meta" ? metaToolListing() : listing(served),
  }));

  // In meta mode a CallTool naming a real tool is routed through the same
  // callTool as tool_invoke, so clients that already know a name keep working;
  // the served set still bounds what is reachable.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (mode === "meta" && isMetaToolName(name)) {
      return runMetaTool(served, name, args, callTool);
    }
    return callTool(name, args);
  });

  return server;
}

export async function startStdioServer(mode: McpMode = "full") {
  const server = createMcpServer({ agentSessionId: agentSessionFromEnv(), mode });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server running on stdio");
}
