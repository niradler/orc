import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "@orc/core/config";
import { createLogger } from "@orc/core/logger";
import { MCP_PROMPT_REQUEST_ARG, renderMcpPrompt } from "@orc/core/mcp-prompts";
import { getSqlite } from "@orc/db/client";
import { McpPromptStore } from "@orc/db/mcp-prompts";
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
import { availablePreviewTools, previewToolContent } from "./preview-tools.js";
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

export function createMcpServer({ mode, project, projects, ...options }: McpServerOptions = {}) {
  if (project !== undefined && projects !== undefined)
    throw new Error("Use project or projects, not both");
  const names = projects ? normalizeMcpProjects(projects) : parseMcpProjects(project);
  const selected = names ? resolveMcpProjects(names) : undefined;
  const selectedMode = mode ?? loadConfig().mcp.default_mode;
  const server = new Server(
    { name: "orc", version: "0.0.1" },
    { capabilities: { tools: {}, prompts: {} } },
  );

  // The set of tools this connection serves. Every lookup, listing and meta
  // search goes through it, so a future subset filter only changes this line.
  async function servedTools(args?: unknown): Promise<readonly ListedTool[]> {
    const input = z
      .object({
        session_id: z.string().min(1).max(200).optional(),
        client_id: z.string().uuid().optional(),
      })
      .safeParse(args);
    const scope =
      (options.previewScope
        ? {
            ...options.previewScope,
            clientId:
              options.previewScope.clientId ?? (input.success ? input.data.client_id : undefined),
          }
        : undefined) ??
      (input.success && input.data.session_id
        ? { sessionId: input.data.session_id, clientId: input.data.client_id }
        : undefined);
    const available = await availablePreviewTools(
      scope,
      selected?.map((project) => project.id),
    );
    return toolDefinitions.filter(
      (tool) => !tool.name.startsWith("preview_") || available.has(tool.name),
    );
  }

  async function callTool(name: string, args: unknown): Promise<ToolResult> {
    logger.debug(
      `Tool call: ${name}`,
      name === "session_handoff" ||
        name === "tool_invoke" ||
        name === "human_request" ||
        name === "command_request" ||
        name.startsWith("channel_")
        ? undefined
        : name.startsWith("preview_")
          ? undefined
          : args,
    );

    try {
      const served = await servedTools(args);
      // Request status remains readable after a target disconnects; scope is still checked.
      const toolDef = (name === "preview_request_get" ? toolDefinitions : served).find(
        (t) => t.name === name,
      );
      if (!toolDef) {
        return {
          content: [
            {
              type: "text" as const,
              text: name.startsWith("preview_")
                ? `Preview capability unavailable for this session/desktop. Connect the intended desktop, select the session and check Browser permissions; refresh discovery. (${name})`
                : `Unknown tool: ${name}`,
            },
          ],
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
      const status = name.startsWith("preview_")
        ? z.object({ status: z.string() }).safeParse(JSON.parse(result))
        : null;
      return {
        content: previewToolContent(name, result),
        ...(status?.success && !["opened", "completed"].includes(status.data.status)
          ? { isError: true }
          : {}),
      };
    } catch (err) {
      logger.error(`Tool error: ${name}`, err);
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: selectedMode === "meta" ? metaToolListing() : listing(await servedTools()),
  }));

  // In meta mode a CallTool naming a real tool is routed through the same
  // callTool as tool_invoke, so clients that already know a name keep working;
  // the served set still bounds what is reachable.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (selectedMode === "meta" && isMetaToolName(name)) {
      const discoveryArgs =
        name === "tool_invoke"
          ? z.object({ arguments: z.unknown().optional() }).parse(args).arguments
          : args;
      return runMetaTool(await servedTools(discoveryArgs), name, args, callTool);
    }
    return callTool(name, args);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: new McpPromptStore(getSqlite()).list().map(({ name, title, description }) => ({
      name,
      title,
      description,
      arguments: [
        {
          name: MCP_PROMPT_REQUEST_ARG,
          description: "What you need, in your own words",
          required: false,
        },
      ],
    })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = new McpPromptStore(getSqlite()).get(request.params.name);
    if (!prompt) throw new Error(`Unknown prompt: ${request.params.name}`);
    const { [MCP_PROMPT_REQUEST_ARG]: input, ...unknown } = request.params.arguments ?? {};
    if (Object.keys(unknown).length)
      throw new Error(`Prompts accept only the "${MCP_PROMPT_REQUEST_ARG}" argument`);
    return {
      description: prompt.description,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: renderMcpPrompt(prompt, input) },
        },
      ],
    };
  });

  return server;
}

export async function startStdioServer(mode?: McpMode) {
  const server = createMcpServer({
    agentSessionId: agentSessionFromEnv(),
    ...(agentSessionFromEnv()
      ? { previewScope: { sessionId: agentSessionFromEnv() as string } }
      : {}),
    ...(mode ? { mode } : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server running on stdio");
}
