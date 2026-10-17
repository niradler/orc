import { z } from "zod";
import type { toolDefinitions } from "./tools.js";

export const MCP_MODES = ["full", "meta"] as const;
export type McpMode = (typeof MCP_MODES)[number];

export function parseMcpMode(value: string | null | undefined): McpMode {
  if (value === null || value === undefined) return "full";
  if ((MCP_MODES as readonly string[]).includes(value)) return value as McpMode;
  throw new Error(`Invalid mcp mode "${value}". Valid modes: ${MCP_MODES.join(", ")}`);
}

export type ServedTool = (typeof toolDefinitions)[number];

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const searchInput = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Words describing what you want to do, e.g. 'create task'. Omit or leave empty to list every tool grouped by toolset.",
    ),
  limit: z.number().int().min(1).max(50).default(10).describe("Max results for a query search"),
});
const describeInput = z.object({ name: z.string().min(1) });
const invokeInput = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const metaToolDefinitions = [
  {
    name: "tool_search",
    description:
      "Search the available ORC tools by name or description. Returns tool names with a one-line summary; " +
      "call tool_describe for a tool's full schema, then tool_invoke to run it. " +
      "Omit the query to get an overview of every tool grouped by toolset.",
    inputSchema: searchInput,
  },
  {
    name: "tool_describe",
    description: "Return the full description and JSON input schema of one ORC tool.",
    inputSchema: describeInput,
  },
  {
    name: "tool_invoke",
    description:
      "Run an ORC tool by name with the given arguments. Arguments are validated against the tool's schema.",
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

function closeNames(served: readonly ServedTool[], name: string): string[] {
  const needle = name.toLowerCase();
  return served
    .map((t) => t.name)
    .filter((n) => n.toLowerCase().includes(needle) || needle.includes(n.toLowerCase()))
    .slice(0, 5);
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

export async function runMetaTool(
  served: readonly ServedTool[],
  name: MetaToolName,
  args: unknown,
  callTool: (name: string, args: unknown) => Promise<ToolResult>,
): Promise<ToolResult> {
  switch (name) {
    case "tool_search": {
      const parsed = searchInput.safeParse(args ?? {});
      if (!parsed.success) return text(`Invalid args: ${parsed.error.message}`, true);
      const query = parsed.data.query ?? "";
      if (terms(query).length === 0) return text(toolOverview(served));
      const hits = searchTools(served, query, parsed.data.limit);
      if (hits.length === 0) return text("No matching tools.");
      const lines = hits.map((t) => `${t.name}: ${firstLine(t.description)}`);
      return text(`${lines.join("\n")}\n\nCall tool_describe with a name to get its input schema.`);
    }
    case "tool_describe": {
      const parsed = describeInput.safeParse(args ?? {});
      if (!parsed.success) return text(`Invalid args: ${parsed.error.message}`, true);
      const tool = served.find((t) => t.name === parsed.data.name);
      if (!tool) {
        const close = closeNames(served, parsed.data.name);
        const hint = close.length > 0 ? ` Close names: ${close.join(", ")}` : "";
        return text(`Unknown tool: ${parsed.data.name}.${hint}`, true);
      }
      return text(
        JSON.stringify(
          {
            name: tool.name,
            description: tool.description,
            inputSchema: z.toJSONSchema(tool.inputSchema, { target: "draft-7", io: "input" }),
          },
          null,
          2,
        ),
      );
    }
    case "tool_invoke": {
      const parsed = invokeInput.safeParse(args ?? {});
      if (!parsed.success) return text(`Invalid args: ${parsed.error.message}`, true);
      return callTool(parsed.data.name, parsed.data.arguments);
    }
  }
}
