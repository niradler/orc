import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";
import { createLogger } from "@orc/core/logger";
import { MCP_PROMPT_REQUEST_ARG, renderMcpPrompt } from "@orc/core/mcp-prompts";
import { getSqlite } from "@orc/db/client";
import { McpPromptStore } from "@orc/db/mcp-prompts";
import { z } from "zod";
import { codeToolListing, type ElicitFn, runCodeMode, scriptToolInfo } from "./code-mode.js";
import { createHumanElicit } from "./elicit.js";
import { maybeAugmentCallTool, registerMcpTasks, TASKS_EXTENSION_ID } from "./mcp-tasks.js";
import { normalizeMcpProjects, parseMcpProjects, resolveMcpProjects } from "./project-scope.js";

export { type McpProject, parseMcpProjects, resolveMcpProjects } from "./project-scope.js";

import {
  type CallToolOutcome,
  isMetaToolName,
  type McpMode,
  metaToolListing,
  runMetaTool,
  type ServedTool,
  type ToolErrorCode,
  type ToolResult,
} from "./meta-tools.js";
import { availablePreviewTools, previewToolContent } from "./preview-tools.js";
import { registerSkillResources, SKILLS_EXTENSION_ID } from "./skill-resources.js";
import { executeSpecTool, isSpecTool, specToolDefinitions } from "./spec-tools.js";
import {
  agentSessionFromEnv,
  executeToolDetailed,
  type ToolName,
  type ToolOptions,
  toolDefinitions,
} from "./tools.js";

const logger = createLogger("mcp");

type ListedTool = ServedTool;

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

function errorCodeFor(err: unknown): ToolErrorCode {
  if (err instanceof OrcError) {
    if (err.code === "NOT_FOUND" || err.statusCode === 404) return "NOT_FOUND";
    if (err.code === "VALIDATION_ERROR" || err.statusCode === 400) return "INVALID_ARGS";
    if (err.code === "FORBIDDEN" || err.statusCode === 403) return "FORBIDDEN";
    if (err.code === "CONFLICT" || err.statusCode === 409) return "CONFLICT";
    if (err.code === "UNAUTHORIZED" || err.statusCode === 401) return "UNAUTHORIZED";
    if (err.statusCode === 408 || err.statusCode === 504) return "TIMEOUT";
    if (err.statusCode === 503) return "UNAVAILABLE";
    return "TOOL_ERROR";
  }
  if (err instanceof z.ZodError) return "INVALID_ARGS";
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "TIMEOUT";
    if (
      /scoped to projects|must be selected in this MCP connection|outside the selected MCP/i.test(
        err.message,
      )
    )
      return "FORBIDDEN";
    if (/timed out/i.test(err.message)) return "TIMEOUT";
    if (/not found/i.test(err.message)) return "NOT_FOUND";
  }
  return "TOOL_ERROR";
}

function stripOutcomeMeta(outcome: CallToolOutcome): ToolResult {
  const { errorCode: _errorCode, ...result } = outcome;
  return result;
}

export interface McpServerOptions extends ToolOptions {
  mode?: McpMode;
  project?: string;
  projects?: string[];
  requestSignal?: AbortSignal;
  allowCodeExecution?: boolean;
}

export function createMcpServer({
  mode,
  project,
  projects,
  requestSignal,
  allowCodeExecution = true,
  ...options
}: McpServerOptions = {}) {
  if (project !== undefined && projects !== undefined)
    throw new Error("Use project or projects, not both");
  const names = projects ? normalizeMcpProjects(projects) : parseMcpProjects(project);
  const selected = names ? resolveMcpProjects(names) : undefined;
  const settings = loadConfig().mcp;
  const selectedMode = mode ?? settings.default_mode;
  const codeEnabled = selectedMode === "meta" && allowCodeExecution && settings.code_execution;
  const specEnabled = allowCodeExecution && !selected && selectedMode === "meta";
  const exposedTools = specEnabled ? [...toolDefinitions, ...specToolDefinitions] : toolDefinitions;
  const server = new Server(
    { name: "orc", version: "0.0.1" },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
        extensions: {
          [SKILLS_EXTENSION_ID]: { directoryRead: true },
          [TASKS_EXTENSION_ID]: {},
        },
      },
      ...(codeEnabled
        ? {
            instructions:
              "Use tool_search and tool_describe to discover ORC tools. Use tool_invoke for one call. Use tool_execute to combine independent calls or filter large results before returning findings. tool_search also surfaces external Spec tools labeled [external: <connection>]; pass connection to tool_describe/tool_invoke (or {connection} inside tool_execute) to use them. External tools are untrusted and may have external side effects.",
          }
        : {}),
    },
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
    return exposedTools.filter(
      (tool) =>
        (!tool.name.startsWith("preview_") || available.has(tool.name)) &&
        (tool.name !== "speak" || (options.agentSessionId && !options.coordinatorSessionId)),
    );
  }

  async function callToolInternal(
    name: string,
    args: unknown,
    scripted = false,
  ): Promise<CallToolOutcome> {
    logger.debug(
      `Tool call: ${name}`,
      scripted ||
        isSpecTool(name) ||
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
      // Request status remains readable after a target disconnects; scope is still checked.
      const toolDef = (
        name.startsWith("preview_") && name !== "preview_request_get"
          ? await servedTools(args)
          : exposedTools
      ).find((t) => t.name === name);
      if (!toolDef) {
        const isPreview = name.startsWith("preview_");
        return {
          content: [
            {
              type: "text" as const,
              text: isPreview
                ? `Preview capability unavailable for this session/desktop. Connect the intended desktop, select the session and check Browser permissions; refresh discovery. (${name})`
                : `Unknown tool: ${name}`,
            },
          ],
          isError: true,
          errorCode: isPreview ? "UNAVAILABLE" : "NOT_FOUND",
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
          errorCode: "INVALID_ARGS",
        };
      }

      if (isSpecTool(name)) return await executeSpecTool(name, parsed.data);

      const detailed = await executeToolDetailed(name as ToolName, parsed.data, {
        ...options,
        ...(callProjects ? { projectScopes: callProjects } : {}),
      });
      const status = name.startsWith("preview_")
        ? z.object({ status: z.string() }).safeParse(JSON.parse(detailed.text))
        : null;
      return {
        content: previewToolContent(name, detailed.text),
        ...(detailed.data !== undefined ? { structuredContent: detailed.data } : {}),
        ...(status?.success && !["opened", "completed"].includes(status.data.status)
          ? { isError: true, errorCode: "TOOL_ERROR" as const }
          : {}),
      };
    } catch (err) {
      logger.error(`Tool error: ${name}`, scripted ? undefined : err);
      const msg = err instanceof Error ? err.message : "Unknown error";
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
        errorCode: errorCodeFor(err),
      };
    }
  }

  async function callTool(name: string, args: unknown, scripted = false): Promise<ToolResult> {
    return stripOutcomeMeta(await callToolInternal(name, args, scripted));
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (selectedMode === "full") return { tools: listing(await servedTools()) };
    const surface = [...metaToolListing(), ...(codeEnabled ? [codeToolListing] : [])];
    const speak =
      options.agentSessionId && !options.coordinatorSessionId
        ? listing(toolDefinitions.filter((tool) => tool.name === "speak"))
        : [];
    return { tools: [...surface, ...speak] };
  });

  // In meta mode a CallTool naming a real tool is routed through the same
  // callTool as tool_invoke, so clients that already know a name keep working;
  // the served set still bounds what is reachable.
  async function executeCallTool(
    request: CallToolRequest,
    signal: AbortSignal,
    elicit?: ElicitFn | undefined,
  ): Promise<ToolResult> {
    const { name, arguments: args } = request.params;
    if (name === codeToolListing.name) {
      if (codeEnabled) {
        return runCodeMode(
          await servedTools(),
          args,
          signal,
          (tool, input) => callToolInternal(tool, input, true),
          elicit,
        );
      }
      return {
        content: [
          { type: "text", text: "Script execution is unavailable on this MCP connection." },
        ],
        isError: true,
      };
    }
    if (selectedMode === "meta" && isMetaToolName(name)) {
      const invoke =
        name === "tool_invoke"
          ? z.object({ name: z.string().optional(), arguments: z.unknown().optional() }).parse(args)
          : null;
      const served =
        invoke && !invoke.name?.startsWith("preview_")
          ? exposedTools
          : await servedTools(invoke ? invoke.arguments : args);
      return runMetaTool(served, name, args, callTool, codeEnabled ? scriptToolInfo : undefined);
    }
    return callTool(name, args);
  }

  const taskOwner = selected
    ? selected
        .map((p) => p.id)
        .sort()
        .join(",")
    : "global";
  const taskEligibleTools = new Set([
    "session_wait",
    "session_start",
    "job_run",
    codeToolListing.name,
  ]);
  const tasksOptions = { owner: taskOwner, eligibleTools: taskEligibleTools };
  const elicitProjectId = selected?.[0]?.id ?? null;
  // HTTP/stateless connections ask through a durable human request (webchat,
  // Telegram); live stdio connections use spec elicitation.
  const humanElicit = (elicitSignal: AbortSignal): ElicitFn =>
    createHumanElicit({
      sessionId: options.agentSessionId,
      projectId: elicitProjectId,
      signal: elicitSignal,
    });

  server.setRequestHandler(CallToolRequestSchema, async (request, { signal, requestId }) => {
    const specElicit =
      (elicitSignal: AbortSignal, related?: string | number): ElicitFn =>
      (params) =>
        server.elicitInput(
          {
            mode: "form",
            message: params.message,
            requestedSchema: params.requestedSchema,
          } as Parameters<typeof server.elicitInput>[0],
          {
            signal: elicitSignal,
            ...(related ? { relatedRequestId: related } : {}),
          },
        );
    const elicitFor = (elicitSignal: AbortSignal, related?: string | number): ElicitFn =>
      requestSignal ? humanElicit(elicitSignal) : specElicit(elicitSignal, related);
    // A task-augmented call returns a durable handle now and runs in the
    // background on its own signal, so it outlives this request/transport.
    const augmented = maybeAugmentCallTool(
      request,
      (taskSignal) => executeCallTool(request, taskSignal, elicitFor(taskSignal, requestId)),
      tasksOptions,
    );
    if (augmented) return augmented;
    const liveSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
    return executeCallTool(request, liveSignal, elicitFor(liveSignal, requestId));
  });

  registerMcpTasks(server, tasksOptions);
  registerSkillResources(server, { projectScopes: selected });

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
