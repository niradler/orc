import { z } from "zod";
import { CODE_LIMITS, hasBoundedJsonShape } from "./code-protocol.js";
import { runCodeWorker } from "./code-runner.js";
import { describeServedTool, type ServedTool, searchTools, type ToolResult } from "./meta-tools.js";

type ToolName = ServedTool["name"];

const readable: ReadonlySet<ToolName> = new Set<ToolName>([
  "context",
  "project_list",
  "task_list",
  "task_get",
  "search",
  "kb_list",
  "kb_search",
  "kb_read",
  "kb_evidence",
  "kb_documents",
  "memory_list",
  "memory_read",
  "memory_history",
  "pad_list",
  "pad_get",
  "job_list",
  "job_status",
  "session_list",
  "session_status",
  "session_search",
  "session_read",
  "skill_list",
  "skill_read",
  "skill_history",
  "agent_list",
  "agent_read",
  "agent_package_list",
  "agent_package_read",
  "flow_list",
  "flow_read",
  "flow_status",
  "preview_browser_snapshot",
  "spec_list",
  "spec_tools",
  "spec_describe",
]);
const writable: ReadonlySet<ToolName> = new Set<ToolName>([
  "task_create",
  "task_update",
  "task_batch_create",
  "task_link",
  "memory_create",
  "memory_update",
  "pad_create",
  "pad_update",
  "spec_invoke",
]);

const outputHints: Partial<Record<ToolName, string>> = {
  task_list:
    "Plain text, one task per line: [id] status priority progress% title. An empty list is a message.",
  job_list:
    "Plain text, one job per line: enabled marker, name, trigger type, run count and [id: …].",
  memory_list:
    "Plain text, one memory per line. Use memory_read with its name to fetch the content.",
  memory_read: "Markdown text with a heading, description, blank line and memory content.",
  project_list: "Plain text, one project per line with name, status and [id: …].",
};

const inputSchema = z.strictObject({
  code: z.string().min(1).max(CODE_LIMITS.sourceBytes).describe("JavaScript async function body"),
  timeout_ms: z.number().int().min(100).max(CODE_LIMITS.maxTimeoutMs).optional(),
});
const outputSchema = z.object({
  result: z.json(),
  logs: z.array(z.string()),
  truncated: z.boolean(),
});

export const codeToolListing = {
  name: "tool_execute",
  description:
    "Run an isolated JavaScript async function body. Use await and return directly. " +
    "Use tool_search and tool_describe to discover scriptable tools. Prefer tool_invoke for one small, direct result. " +
    'Discover tools with const { tools: hits } = await tools.search("list active tasks"). ' +
    'An empty query pages through the catalog with tools.search("", { limit: 20, offset: 0 }). ' +
    "Use await tools.describe(name) for inputSchema, effect and any output hint, then await tools.call(name, args). " +
    "Independent reads can use Promise.all; calls with writes are serialized. " +
    "Call results are JSON or plain text (for example, task_list returns lines); failures reject. Return only the fields or summary you need. " +
    "Executions are fresh and can commit writes before failing. Avoid automatic retries of writes. " +
    "Only the JSON return value and bounded console logs are returned.",
  inputSchema: z.toJSONSchema(inputSchema, { target: "draft-7", io: "input" }),
  outputSchema: z.toJSONSchema(outputSchema, { target: "draft-7" }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

const nameSchema = z.string().min(1).max(100);
const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("search"),
    name: z.string().max(300),
    args: z.object({
      limit: z.number().int().min(1).max(25).default(8),
      offset: z.number().int().min(0).max(100).default(0),
    }),
  }),
  z.object({ operation: z.literal("describe"), name: nameSchema }),
  z.object({
    operation: z.literal("call"),
    name: nameSchema,
    args: z.record(z.string(), z.json()),
  }),
]);

export function toolEffect(name: ToolName): "read" | "write" | undefined {
  if (readable.has(name)) return "read";
  if (writable.has(name)) return "write";
}

export function scriptToolInfo(name: ToolName) {
  const effect = toolEffect(name);
  return {
    scriptable: effect !== undefined,
    ...(effect ? { effect } : {}),
    ...(outputHints[name] ? { output: outputHints[name] } : {}),
  };
}

function encodeReply(reply: { value: unknown } | { error: string }): string {
  const payload = JSON.stringify(reply);
  if (Buffer.byteLength(payload) <= CODE_LIMITS.responseBytes) return payload;
  return JSON.stringify({
    error: "Tool response exceeded the bridge limit. Narrow the tool arguments.",
  });
}

function asBridgeValue(result: ToolResult): string {
  const text = result.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");
  if (result.isError) return encodeReply({ error: text.slice(0, 512) || "Tool failed" });
  if (result.structuredContent) return encodeReply({ value: result.structuredContent });
  if (Buffer.byteLength(text) > CODE_LIMITS.responseBytes) {
    return encodeReply({
      error: "Tool response exceeded the bridge limit. Narrow the tool arguments.",
    });
  }
  try {
    return encodeReply({ value: JSON.parse(text) });
  } catch {
    return encodeReply({ value: text });
  }
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function runCodeMode(
  served: readonly ServedTool[],
  input: unknown,
  signal: AbortSignal,
  callTool: (name: string, args: unknown) => Promise<ToolResult>,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || Buffer.byteLength(parsed.data.code) > CODE_LIMITS.sourceBytes) {
    return toolError(
      "Expected a JavaScript code body of up to 32 KiB and an optional timeout_ms from 100 to 25000.",
    );
  }
  const tools = served.filter((tool) => toolEffect(tool.name));
  try {
    const output = await runCodeWorker(
      parsed.data.code,
      parsed.data.timeout_ms ?? CODE_LIMITS.defaultTimeoutMs,
      signal,
      (payload) => {
        if (payload.length > CODE_LIMITS.requestChars || !hasBoundedJsonShape(payload))
          throw new Error("Tool request exceeded its size or complexity limit");
        const request = requestSchema.parse(JSON.parse(payload));
        const tool = tools.find((candidate) => candidate.name === request.name);
        return {
          serial: request.operation === "call" && !!tool && toolEffect(tool.name) === "write",
          ...(request.operation === "call" && tool ? { toolName: tool.name } : {}),
          async dispatch() {
            if (request.operation === "search") {
              const hits = request.name.trim()
                ? searchTools(tools, request.name, tools.length)
                : tools;
              const { offset, limit } = request.args;
              return encodeReply({
                value: {
                  tools: hits.slice(offset, offset + limit).map((hit) => ({
                    name: hit.name,
                    description: hit.description.split(/\r?\n/)[0]?.slice(0, 180),
                    effect: toolEffect(hit.name),
                  })),
                  total: hits.length,
                },
              });
            }
            if (!tool)
              return encodeReply({ error: `Tool unavailable in code mode: ${request.name}` });
            if (request.operation === "describe") {
              return encodeReply({
                value: {
                  ...describeServedTool(tool),
                  ...scriptToolInfo(tool.name),
                },
              });
            }
            return asBridgeValue(await callTool(tool.name, request.args));
          },
        };
      },
    );
    const structuredContent = { ...output };
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent };
  } catch (error) {
    return toolError(error instanceof Error ? error.message : "Code execution failed");
  }
}
