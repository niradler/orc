import { MCP_MODES, type McpSettings } from "@orc/core/mcp-settings";
import { z } from "zod";
import {
  discoverSpecTools,
  externalHitLine,
  listSpecConnections,
  markExternal,
  type SpecDiscovery,
  specSignpost,
} from "./spec-discovery.js";
import type { specToolDefinitions } from "./spec-tools.js";
import type { toolDefinitions } from "./tools.js";

export { MCP_MODES };
export type McpMode = McpSettings["default_mode"];

export function parseMcpMode(value: string | null | undefined): McpMode {
  if (value === null || value === undefined) return "meta";
  if ((MCP_MODES as readonly string[]).includes(value)) return value as McpMode;
  throw new Error(`Invalid mcp mode "${value}". Valid modes: ${MCP_MODES.join(", ")}`);
}

export type ServedTool = (typeof toolDefinitions)[number] | (typeof specToolDefinitions)[number];

export type ToolErrorCode =
  | "NOT_FOUND"
  | "INVALID_ARGS"
  | "TIMEOUT"
  | "FORBIDDEN"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "UNAVAILABLE"
  | "LIMIT_EXCEEDED"
  | "TOOL_ERROR";

export type ToolResult = {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string; text?: never }
  )[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export type CallToolOutcome = ToolResult & { errorCode?: ToolErrorCode };

const searchInput = z.object({
  connection: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "External Spec connection (a registered OpenAPI/MCP/GraphQL server) to search; its tools are external, not ORC built-ins",
    ),
  session_id: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Intended preview session for capability-aware discovery; cannot override a connection binding",
    ),
  client_id: z.string().uuid().optional(),
  query: z
    .string()
    .optional()
    .describe(
      "Words describing what you want to do, e.g. 'create task'. Omit or leave empty to list every tool grouped by toolset.",
    ),
  queries: z.array(z.string().min(1).max(300)).min(1).max(8).optional(),
  scriptable: z.boolean().optional().describe("Limit results to tools callable from tool_execute"),
  limit: z.number().int().min(1).max(50).default(10).describe("Max results for a query search"),
});
const describeInput = z.object({
  connection: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("External Spec connection for an exact tool name (results are external tools)"),
  name: z.string().min(1).optional(),
  names: z.array(z.string().min(1).max(200)).min(1).max(8).optional(),
  session_id: z.string().min(1).max(200).optional(),
  client_id: z.string().uuid().optional(),
});
const invokeInput = z.object({
  connection: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "External Spec connection for this tool (invokes an external tool, may have external side effects)",
    ),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const metaToolDefinitions = [
  {
    name: "tool_search",
    description:
      "Search the available ORC tools by name or description. Returns tool names with a one-line summary; " +
      "external tools from registered Spec connections are included and labeled [external: <connection>]. " +
      "Use queries for batch discovery, or connection to search one external Spec connection directly. Call tool_describe for schemas, tool_invoke for a direct call, or tool_execute for scriptable tools. " +
      "Omit the query to get an overview of every tool grouped by toolset plus the external connections.",
    inputSchema: searchInput,
  },
  {
    name: "tool_describe",
    description:
      "Return descriptions and JSON input schemas. Use name for one tool or names for up to eight.",
    inputSchema: describeInput,
  },
  {
    name: "tool_invoke",
    description:
      "Run an ORC tool by name with the given arguments. Pass connection to invoke a tool on a registered Spec connection. Arguments are validated against the tool's schema.",
    inputSchema: invokeInput,
  },
] as const;

export type MetaToolName = (typeof metaToolDefinitions)[number]["name"];

export function isMetaToolName(name: string): name is MetaToolName {
  return metaToolDefinitions.some((t) => t.name === name);
}

export function metaToolListing() {
  return metaToolDefinitions.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.inputSchema, { target: "draft-7", io: "input" }),
    ...(t.name === "tool_invoke"
      ? {}
      : {
          annotations: { readOnlyHint: true },
        }),
  }));
}

const text = (value: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

function firstLine(description: string): string {
  const line = description.trim().split(/\r?\n/)[0] ?? "";
  const sentence = line.match(/^.*?[.!?](?=\s|$)/);
  return (sentence ? sentence[0] : line).trim();
}

export function closeNames(served: readonly ServedTool[], name: string): string[] {
  const needle = name.trim().toLowerCase();
  if (!needle) return [];
  const seen = new Set<string>();
  const matches: string[] = [];
  const add = (candidate: string) => {
    if (seen.has(candidate) || matches.length >= 5) return;
    seen.add(candidate);
    matches.push(candidate);
  };
  for (const tool of served) {
    const lower = tool.name.toLowerCase();
    if (lower.includes(needle) || needle.includes(lower)) add(tool.name);
  }
  if (matches.length < 5) {
    const needleTokens = new Set(terms(needle));
    if (needleTokens.size > 0) {
      const scored = served
        .filter((tool) => !seen.has(tool.name))
        .map((tool) => {
          const overlap = terms(tool.name).filter((token) => needleTokens.has(token)).length;
          return { name: tool.name, overlap };
        })
        .filter((entry) => entry.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap || a.name.localeCompare(b.name));
      for (const entry of scored) add(entry.name);
    }
  }
  return matches;
}

const STOPWORDS = new Set(
  "a an and are as at be by do for from how i in is it its me my of on or the this to use what with you".split(
    " ",
  ),
);
// Name terms count more than description terms; snake_case names split into words.
const NAME_WEIGHT = 3;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

// Until the tool registry assigns toolsets, group by name prefix; single-word tools are "core".
function toolsetOf(name: string): string {
  const at = name.indexOf("_");
  return at === -1 ? "core" : name.slice(0, at);
}

export function toolOverview(served: readonly ServedTool[]): string {
  const groups = new Map<string, string[]>();
  for (const tool of served) {
    const set = toolsetOf(tool.name);
    groups.set(set, [...(groups.get(set) ?? []), tool.name]);
  }
  const lines = [...groups].map(([set, names]) => `${set} (${names.length}): ${names.join(", ")}`);
  return `${served.length} tools by toolset:\n${lines.join("\n")}\n\nSearch with a query for descriptions, or call tool_describe with a name.`;
}

// BM25 over name + description, ranked by how well any query terms match (not all required).
export function searchTools(served: readonly ServedTool[], query: string, limit: number) {
  const queryTerms = [...new Set(terms(query))];
  if (queryTerms.length === 0) return [];
  const docs = served.map((tool) => {
    const tf = new Map<string, number>();
    const add = (text: string, weight: number) => {
      for (const term of terms(text)) tf.set(term, (tf.get(term) ?? 0) + weight);
    };
    add(tool.name, NAME_WEIGHT);
    add(tool.description, 1);
    let length = 0;
    for (const count of tf.values()) length += count;
    return { tool, tf, length };
  });
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1);
  const idf = new Map(
    queryTerms.map((term) => {
      const n = docs.filter((d) => d.tf.has(term)).length;
      return [term, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))];
    }),
  );
  const exact = query.trim().toLowerCase();
  return docs
    .map(({ tool, tf, length }) => {
      let score = tool.name === exact ? Number.POSITIVE_INFINITY : 0;
      for (const term of queryTerms) {
        const f = tf.get(term) ?? 0;
        if (f === 0) continue;
        const norm = BM25_K1 * (1 - BM25_B + (BM25_B * length) / avgLength);
        score += (idf.get(term) ?? 0) * ((f * (BM25_K1 + 1)) / (f + norm));
      }
      return { tool, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.tool);
}

export function describeServedTool(tool: ServedTool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema, { target: "draft-7", io: "input" }),
  };
}

export async function runMetaTool(
  served: readonly ServedTool[],
  name: MetaToolName,
  args: unknown,
  callTool: (name: string, args: unknown) => Promise<ToolResult>,
  scriptInfo?: (name: ServedTool["name"]) => {
    scriptable: boolean;
    effect?: string;
    output?: string;
  },
): Promise<ToolResult> {
  switch (name) {
    case "tool_search": {
      const parsed = searchInput.safeParse(args ?? {});
      if (!parsed.success) return text(`Invalid args: ${parsed.error.message}`, true);
      if (parsed.data.query !== undefined && parsed.data.queries)
        return text("Use query or queries.", true);
      if (parsed.data.connection) {
        if (parsed.data.queries) return text("Use query when searching a Spec connection.", true);
        if (parsed.data.scriptable && !scriptInfo?.("spec_invoke").scriptable) {
          return text("No scriptable tools on this connection.");
        }
        return callTool("spec_tools", {
          connection: parsed.data.connection,
          query: parsed.data.query,
          limit: parsed.data.limit,
        });
      }
      const eligible = parsed.data.scriptable
        ? served.filter((tool) => scriptInfo?.(tool.name).scriptable)
        : served;
      const summarize = (t: ServedTool) => ({
        name: t.name,
        description: firstLine(t.description),
        ...(scriptInfo ? scriptInfo(t.name) : { scriptable: false }),
      });
      const specAvailable = served.some((tool) => tool.name === "spec_invoke");
      if (parsed.data.queries) {
        const discovery = specAvailable
          ? await discoverSpecTools(callTool, parsed.data.queries)
          : ({ connections: [], hitsByQuery: new Map(), partial: false } as SpecDiscovery);
        const results = parsed.data.queries.map((query) => ({
          query,
          tools: searchTools(eligible, query, Math.min(parsed.data.limit, 10)).map(summarize),
          external: discovery.hitsByQuery.get(query) ?? [],
        }));
        return {
          ...text(JSON.stringify(results)),
          structuredContent: {
            results,
            connections: discovery.connections,
            ...(discovery.partial ? { partial: true } : {}),
          },
        };
      }
      const query = parsed.data.query ?? "";
      if (terms(query).length === 0) {
        const connections = specAvailable
          ? await listSpecConnections(callTool).catch(() => [])
          : [];
        return {
          ...text(toolOverview(eligible) + specSignpost(connections)),
          structuredContent: { connections },
        };
      }
      const hits = searchTools(eligible, query, parsed.data.limit);
      const tools = hits.map(summarize);
      const discovery = specAvailable
        ? await discoverSpecTools(callTool, [query])
        : ({ connections: [], hitsByQuery: new Map(), partial: false } as SpecDiscovery);
      const external = discovery.hitsByQuery.get(query) ?? [];
      if (tools.length === 0 && external.length === 0)
        return text(`No matching tools.${specSignpost(discovery.connections)}`);
      const lines = [
        ...tools.map((t) => `${t.name}: ${t.description}${t.scriptable ? " [scriptable]" : ""}`),
        ...external.map((hit) => externalHitLine(hit, firstLine)),
      ];
      return {
        ...text(
          `${lines.join("\n")}\n\nCall tool_describe with a name (pass connection for external tools) to get its input schema.${specSignpost(discovery.connections)}`,
        ),
        structuredContent: {
          tools,
          external,
          connections: discovery.connections,
          ...(discovery.partial ? { partial: true } : {}),
        },
      };
    }
    case "tool_describe": {
      const parsed = describeInput.safeParse(args ?? {});
      if (!parsed.success) return text(`Invalid args: ${parsed.error.message}`, true);
      const { name, names } = parsed.data;
      if ((!name && !names) || (name && names)) return text("Use name or names.", true);
      if (parsed.data.connection) {
        if (!name) return text("Use an exact name when describing an external Spec tool.", true);
        return markExternal(
          await callTool("spec_describe", { connection: parsed.data.connection, tool: name }),
          parsed.data.connection,
        );
      }
      const describe = (tool: ServedTool) => ({
        ...describeServedTool(tool),
        ...(scriptInfo ? scriptInfo(tool.name) : { scriptable: false }),
      });
      if (names) {
        const tools = names.map((name) => {
          const tool = served.find((entry) => entry.name === name);
          if (tool) return describe(tool);
          const close = closeNames(served, name);
          return {
            name,
            error: "Unknown tool",
            ...(close.length > 0 ? { close_names: close } : {}),
          };
        });
        return { ...text(JSON.stringify(tools)), structuredContent: { tools } };
      }
      const tool = served.find((t) => t.name === name);
      if (!tool) {
        const close = closeNames(served, name ?? "");
        const hint = close.length > 0 ? ` Close names: ${close.join(", ")}` : "";
        return text(`Unknown tool: ${parsed.data.name}.${hint}`, true);
      }
      const descriptor = describe(tool);
      return { ...text(JSON.stringify(descriptor, null, 2)), structuredContent: descriptor };
    }
    case "tool_invoke": {
      const parsed = invokeInput.safeParse(args ?? {});
      if (!parsed.success) return text(`Invalid args: ${parsed.error.message}`, true);
      if (parsed.data.connection) {
        return callTool("spec_invoke", {
          connection: parsed.data.connection,
          tool: parsed.data.name,
          args: parsed.data.arguments,
        });
      }
      return callTool(parsed.data.name, parsed.data.arguments);
    }
  }
}
