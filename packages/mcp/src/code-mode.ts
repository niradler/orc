import { z } from "zod";
import { CODE_LIMITS, hasBoundedJsonShape } from "./code-protocol.js";
import { runCodeWorker } from "./code-runner.js";
import {
  type CallToolOutcome,
  closeNames,
  describeServedTool,
  type ServedTool,
  searchTools,
  type ToolErrorCode,
  type ToolResult,
} from "./meta-tools.js";
import { discoverSpecTools, markExternal, type SpecDiscovery } from "./spec-discovery.js";

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
  "session_send",
  "spec_invoke",
]);

const outputHints: Partial<Record<ToolName, string>> = {
  context:
    "Structured data: { project, tasks, memories, last_session, active_workers }; text has markdown summary.",
  task_list:
    "Structured data: { tasks: [{ id, title, status, priority, progress, project_id, tags, ... }], count }; text has one task per line.",
  task_get:
    "Structured data: { tasks: [{ id, title, status, priority, progress, body, comments, ... }] }; text has formatted details.",
  flow_status:
    "Structured data: { id, task_id, flow_name, status, active, visits, vars, nodes, ... }; text has formatted ledger.",
  flow_list: "Structured data: { flows, broken }; text has one flow per line.",
  flow_read:
    "Structured data: { name, source, version, description, path, definition }; text has header + JSON.",
  job_list:
    "Structured data: { jobs: [{ id, name, enabled, trigger_type, run_count, project_id }] }; text has one job per line.",
  memory_list:
    "Structured data: { memories, total }; text has one memory per line. Use memory_read with its name to fetch content.",
  memory_read:
    "Structured data: { name, description, content, priority, project_id }; text has markdown heading and content.",
  project_list:
    "Structured data: { projects: [{ id, name, status, description, tags, scope }] }; text has one project per line.",
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
    "Use await tools.describe(name) for inputSchema, effect and any output hint, then await tools.call(name, args, { connection?, timeout_ms? }). " +
    "tools.call never throws: it returns { ok: true, data, text } on success (structured data for typed/JSON tools plus raw text) or { ok: false, error: { code, message } } on failure or timeout. " +
    "Use await tools.allSettled(calls, opts?) with [{ name, args?, connection?, timeout_ms? }] or tools.call(...) promises to keep successful results when one call fails or times out, and tools.pick(objOrArray, keys) to project fields. " +
    "tools.search also returns external tools from registered Spec connections, labeled with a connection field; " +
    "call them with tools.call(name, args, { connection }) and describe them with tools.describe(name, { connection }). " +
    "External tools are not ORC built-ins and may have external side effects. " +
    "Independent reads overlap; writes are serialized. " +
    "Executions are fresh and can commit writes before failing. Avoid automatic retries of writes. " +
    "On a live connection, await tools.elicit(message, requestedSchema) asks the user a form question and " +
    "returns { action, content } where action is accept, decline or cancel; handle decline/cancel explicitly. " +
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

const nameSchema = z.string().min(1).max(200);
const connectionSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(100)
  .optional();
const callTimeoutSchema = z.number().finite().positive().optional();
const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("search"),
    connection: connectionSchema,
    name: z.string().max(300),
    args: z.object({
      limit: z.number().int().min(1).max(25).default(8),
      offset: z.number().int().min(0).max(100).default(0),
    }),
  }),
  z.object({ operation: z.literal("describe"), name: nameSchema, connection: connectionSchema }),
  z.object({
    operation: z.literal("call"),
    connection: connectionSchema,
    name: nameSchema,
    args: z.record(z.string(), z.json()),
    timeout_ms: callTimeoutSchema,
  }),
  z.object({
    operation: z.literal("elicit"),
    connection: connectionSchema,
    name: z.string().min(1).max(2000),
    args: z.record(z.string(), z.json()),
  }),
]);

/** Ask the connected MCP client for user input mid-execution (form elicitation). */
export type ElicitFn = (params: {
  message: string;
  requestedSchema: Record<string, unknown>;
}) => Promise<{
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown> | undefined;
}>;

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

type BridgeCallReply =
  | { ok: true; data: unknown; text: string }
  | { ok: true; text: string; parseJson?: true }
  | { ok: false; error: { code: ToolErrorCode; message: string } };

function encodeCallReply(reply: BridgeCallReply): string {
  const payload = JSON.stringify(reply);
  if (Buffer.byteLength(payload) <= CODE_LIMITS.responseBytes) return payload;
  if (reply.ok && "data" in reply) {
    const compact = JSON.stringify({ ok: true, data: reply.data, text: "" });
    if (Buffer.byteLength(compact) <= CODE_LIMITS.responseBytes) return compact;
  }
  return JSON.stringify({
    ok: false,
    error: {
      code: "LIMIT_EXCEEDED",
      message: "Tool response exceeded the bridge limit. Narrow the tool arguments.",
    },
  });
}

function classifyErrorCode(message: string): ToolErrorCode {
  if (/^Invalid args:/i.test(message)) return "INVALID_ARGS";
  if (/^Unknown tool:|not found/i.test(message)) return "NOT_FOUND";
  if (/timed out/i.test(message)) return "TIMEOUT";
  if (
    /forbidden|only the session that started|requires a bound|scoped to projects|outside the selected MCP|disabled|not allowed|not callable/i.test(
      message,
    )
  )
    return "FORBIDDEN";
  if (/conflict|already exists|limit .* reached|busy/i.test(message)) return "CONFLICT";
  if (/unauthorized/i.test(message)) return "UNAUTHORIZED";
  if (/unavailable/i.test(message)) return "UNAVAILABLE";
  return "TOOL_ERROR";
}

function textContent(result: ToolResult): string {
  return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

function asBridgeValue(result: ToolResult): string {
  const text = textContent(result);
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

function asBridgeCallResult(result: CallToolOutcome): string {
  const text = textContent(result);
  if (result.isError) {
    const message = text.slice(0, 512) || "Tool failed";
    return encodeCallReply({
      ok: false,
      error: { code: result.errorCode ?? classifyErrorCode(message), message },
    });
  }
  if (result.structuredContent !== undefined) {
    return encodeCallReply({ ok: true, data: result.structuredContent, text });
  }
  if (Buffer.byteLength(text) > CODE_LIMITS.responseBytes) {
    return encodeCallReply({
      ok: false,
      error: {
        code: "LIMIT_EXCEEDED",
        message: "Tool response exceeded the bridge limit. Narrow the tool arguments.",
      },
    });
  }
  try {
    JSON.parse(text);
    return encodeCallReply({ ok: true, text, parseJson: true });
  } catch {
    return encodeCallReply({ ok: true, text });
  }
}

async function searchSpec(
  call: (name: string, args: unknown) => Promise<CallToolOutcome>,
  connection: string,
  query: string,
  limit: number,
  offset: number,
): Promise<string> {
  const result = await call("spec_tools", {
    connection,
    query,
    limit: Math.min(50, limit + offset),
  });
  if (result.isError) return asBridgeValue(result);
  const hits = z
    .array(z.object({ id: z.string(), description: z.string() }))
    .parse(JSON.parse(result.content[0]?.text ?? "[]"));
  return encodeReply({
    value: {
      tools: hits
        .slice(offset, offset + limit)
        .map((hit) => ({ name: hit.id, description: hit.description })),
      total: hits.length,
    },
  });
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function clampCallTimeout(requested: number | undefined, capMs: number): number | undefined {
  if (requested === undefined) return undefined;
  return Math.max(1, Math.min(Math.floor(requested), capMs));
}

export async function runCodeMode(
  served: readonly ServedTool[],
  input: unknown,
  signal: AbortSignal,
  callTool: (name: string, args: unknown) => Promise<CallToolOutcome>,
  elicit?: ElicitFn | undefined,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || Buffer.byteLength(parsed.data.code) > CODE_LIMITS.sourceBytes) {
    return toolError(
      "Expected a JavaScript code body of up to 32 KiB and an optional timeout_ms from 100 to 25000.",
    );
  }
  const tools = served.filter((tool) => toolEffect(tool.name));
  const execTimeoutMs = parsed.data.timeout_ms ?? CODE_LIMITS.defaultTimeoutMs;
  try {
    const output = await runCodeWorker(parsed.data.code, execTimeoutMs, signal, (payload) => {
      if (payload.length > CODE_LIMITS.requestChars || !hasBoundedJsonShape(payload))
        throw new Error("Tool request exceeded its size or complexity limit");
      const request = requestSchema.parse(JSON.parse(payload));
      if (request.operation === "elicit") {
        return {
          serial: true,
          pause: true,
          async dispatch() {
            if (!elicit)
              return encodeReply({
                error: "Elicitation needs a live MCP connection; it is unavailable on this call.",
              });
            try {
              const result = await elicit({
                message: request.name,
                requestedSchema: request.args,
              });
              return encodeReply({ value: result });
            } catch (err) {
              return encodeReply({
                error: err instanceof Error ? err.message : "Elicitation failed",
              });
            }
          },
        };
      }
      const connection = request.connection;
      if (connection) {
        if (!tools.some((tool) => tool.name === "spec_invoke")) {
          return {
            serial: false,
            envelope: request.operation === "call",
            async dispatch() {
              const message = "Spec tools are unavailable on this connection";
              return request.operation === "call"
                ? encodeCallReply({ ok: false, error: { code: "UNAVAILABLE", message } })
                : encodeReply({ error: message });
            },
          };
        }
        return {
          serial: request.operation === "call",
          envelope: request.operation === "call",
          ...(request.operation === "call"
            ? {
                toolName: "spec_invoke",
                timeoutMs: clampCallTimeout(request.timeout_ms, execTimeoutMs),
              }
            : {}),
          async dispatch() {
            if (request.operation === "search")
              return searchSpec(
                callTool,
                connection,
                request.name,
                request.args.limit,
                request.args.offset,
              );
            if (request.operation === "describe")
              return asBridgeValue(
                markExternal(
                  await callTool("spec_describe", { connection, tool: request.name }),
                  connection,
                ),
              );
            return asBridgeCallResult(
              await callTool("spec_invoke", {
                connection,
                tool: request.name,
                args: request.args,
              }),
            );
          },
        };
      }
      const tool = tools.find((candidate) => candidate.name === request.name);
      return {
        serial: request.operation === "call" && !!tool && toolEffect(tool.name) === "write",
        envelope: request.operation === "call",
        ...(request.operation === "call"
          ? {
              ...(tool ? { toolName: tool.name } : {}),
              timeoutMs: clampCallTimeout(request.timeout_ms, execTimeoutMs),
            }
          : {}),
        async dispatch() {
          if (request.operation === "search") {
            const hits = request.name.trim()
              ? searchTools(tools, request.name, tools.length)
              : tools;
            const { offset, limit } = request.args;
            const native = hits.slice(offset, offset + limit).map((hit) => ({
              name: hit.name,
              description: hit.description.split(/\r?\n/)[0]?.slice(0, 180),
              effect: toolEffect(hit.name),
            }));
            const specAvailable = tools.some((tool) => tool.name === "spec_invoke");
            const discovery = specAvailable
              ? await discoverSpecTools(callTool, request.name.trim() ? [request.name] : [])
              : ({ connections: [], hitsByQuery: new Map(), partial: false } as SpecDiscovery);
            const external = (discovery.hitsByQuery.get(request.name) ?? []).map((hit) => ({
              name: hit.name,
              description: hit.description.split(/\r?\n/)[0]?.slice(0, 180),
              connection: hit.connection,
              external: true as const,
            }));
            return encodeReply({
              value: {
                tools: [...native, ...external],
                total: hits.length + external.length,
                connections: discovery.connections,
                ...(discovery.partial ? { partial: true } : {}),
              },
            });
          }
          if (!tool) {
            const existsInServed = served.some((candidate) => candidate.name === request.name);
            if (existsInServed) {
              const message = `Tool "${request.name}" is not callable from tool_execute; use tool_invoke instead.`;
              return request.operation === "call"
                ? encodeCallReply({ ok: false, error: { code: "FORBIDDEN", message } })
                : encodeReply({ error: message });
            }
            const close = closeNames(tools, request.name);
            const hint = close.length > 0 ? ` Close names: ${close.join(", ")}` : "";
            const message = `Unknown tool: ${request.name}.${hint}`;
            return request.operation === "call"
              ? encodeCallReply({ ok: false, error: { code: "NOT_FOUND", message } })
              : encodeReply({ error: message });
          }
          if (request.operation === "describe") {
            return encodeReply({
              value: {
                ...describeServedTool(tool),
                ...scriptToolInfo(tool.name),
              },
            });
          }
          return asBridgeCallResult(await callTool(tool.name, request.args));
        },
      };
    });
    const structuredContent = { ...output };
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent };
  } catch (error) {
    return toolError(error instanceof Error ? error.message : "Code execution failed");
  }
}
