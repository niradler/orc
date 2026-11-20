import { z } from "zod";
import { orcApi } from "./api-client.js";
import type { ToolResult } from "./meta-tools.js";

const connection = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(100);
const tool = z
  .string()
  .min(1)
  .max(200)
  .refine((name) => name !== "." && name !== ".." && !/^(?:resource|prompt):/i.test(name));
const target = z.object({ connection, tool }).strict();

export const specToolDefinitions = [
  {
    name: "spec_list",
    description:
      "List enabled external tool connections (OpenAPI/MCP/GraphQL servers) registered in ORC's spec registry. These serve external tools, not ORC built-ins.",
    inputSchema: z.strictObject({}),
  },
  {
    name: "spec_tools",
    description:
      "Search external tools on a registered Spec connection by name or description. Results are external tools, labeled with their connection.",
    inputSchema: z.strictObject({
      connection,
      query: z.string().max(300).optional(),
      limit: z.number().int().min(1).max(50).default(15),
    }),
  },
  {
    name: "spec_describe",
    description:
      "Get the input schema for one external tool on a registered Spec connection. The result is labeled external.",
    inputSchema: target,
  },
  {
    name: "spec_invoke",
    description:
      "Invoke an external tool on a registered Spec connection. Inspect its schema with spec_describe first. OpenAPI results have status and body. External tools may have external side effects.",
    inputSchema: target.extend({ args: z.record(z.string(), z.json()).default({}) }),
  },
] as const;

type SpecToolName = (typeof specToolDefinitions)[number]["name"];

export function isSpecTool(name: string): name is SpecToolName {
  return specToolDefinitions.some((tool) => tool.name === name);
}

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function enabledConnections() {
  const result = await orcApi<{
    connections: {
      name: string;
      type: string | null;
      description: string | null;
      enabled: boolean;
    }[];
  }>("GET", "/integrations/connections", { timeoutMs: 10_000 });
  return result.connections.filter((entry) => entry.enabled);
}

async function requireEnabledConnection(name: string) {
  if (!(await enabledConnections()).some((entry) => entry.name === name))
    throw new Error("Spec connection is unavailable");
}

export async function executeSpecTool(name: SpecToolName, input: unknown): Promise<ToolResult> {
  const base = "/integrations/connections";
  if (name === "spec_list") {
    return jsonResult(await enabledConnections());
  }
  if (name === "spec_tools") {
    const { connection, query, limit } = specToolDefinitions[1].inputSchema.parse(input);
    await requireEnabledConnection(connection);
    const { tools } = await orcApi<{
      tools: { id: string; description: string; enabled: boolean }[];
    }>("GET", `${base}/${encodeURIComponent(connection)}/tools`, { timeoutMs: 10_000 });
    const match = query?.toLowerCase().trim() ?? "";
    return jsonResult(
      tools
        .filter(
          (tool) => tool.enabled && `${tool.id} ${tool.description}`.toLowerCase().includes(match),
        )
        .slice(0, limit),
    );
  }
  const { connection, tool, args } =
    name === "spec_invoke"
      ? specToolDefinitions[3].inputSchema.parse(input)
      : { ...target.parse(input), args: undefined };
  const path = `${base}/${encodeURIComponent(connection)}/tools/${encodeURIComponent(tool)}`;
  if (name === "spec_describe") {
    await requireEnabledConnection(connection);
    const result = await orcApi<{ enabled: boolean }>("GET", path, { timeoutMs: 10_000 });
    if (!result.enabled) throw new Error("Spec tool is disabled");
    return jsonResult(result);
  }
  const result = await orcApi<ToolResult>("POST", `${path}/invoke`, {
    body: { args },
    timeoutMs: 20_000,
  });
  return {
    content: result.content.filter(
      (block) => block.type === "text" && typeof block.text === "string",
    ),
    ...(result.isError ? { isError: true } : {}),
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  };
}
