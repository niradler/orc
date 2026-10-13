import { z } from "zod";
import { ValidationError } from "./errors.js";

// APM's CLI documents named MCP mappings separately from OpenAPM's generic
// dependency-entry schema. Validate that documented form without changing it.
const strings = z.record(z.string(), z.string());
const mcp = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9@_][a-zA-Z0-9._@/:=-]{0,127}$/),
    registry: z.union([z.literal(false), z.url()]).optional(),
    transport: z.enum(["stdio", "http", "sse", "streamable-http"]).optional(),
    command: z
      .string()
      .min(1)
      .refine(
        (value) => !/\s/.test(value),
        "Use one executable in command and put arguments in args",
      )
      .optional(),
    url: z
      .url()
      .refine((value) => /^https?:/.test(value), "MCP URLs use HTTP or HTTPS")
      .optional(),
    args: z
      .union([
        z.array(z.string()),
        z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      ])
      .optional(),
    env: strings.optional(),
    headers: strings.optional(),
    tools: z.array(z.string()).optional(),
    version: z.string().optional(),
    cwd: z.string().optional(),
    package: z.enum(["npm", "pypi", "oci"]).optional(),
  })
  .passthrough()
  .superRefine((entry, context) => {
    if (entry.headers && Object.values(entry.headers).some((value) => /[\r\n]/.test(value)))
      context.addIssue({
        code: "custom",
        path: ["headers"],
        message: "MCP headers cannot contain CR or LF",
      });
    if (entry.registry === false) {
      if (!entry.transport)
        context.addIssue({
          code: "custom",
          path: ["transport"],
          message: "Self-defined MCP servers need a transport",
        });
      else if (entry.transport === "stdio" && !entry.command)
        context.addIssue({
          code: "custom",
          path: ["command"],
          message: "Stdio MCP servers need an executable",
        });
      else if (entry.transport !== "stdio" && !entry.url)
        context.addIssue({
          code: "custom",
          path: ["url"],
          message: "Remote MCP servers need a URL",
        });
    }
  });

export function apmSchemaInput(fields: Record<string, unknown>): Record<string, unknown> {
  const input = structuredClone(fields);
  for (const key of ["dependencies", "devDependencies"]) {
    const block = input[key];
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const declarations = (block as Record<string, unknown>).mcp;
    if (!Array.isArray(declarations)) continue;
    (block as Record<string, unknown>).mcp = declarations.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("name" in entry))
        return entry;
      const result = mcp.safeParse(entry);
      if (!result.success)
        throw new ValidationError(
          `Invalid APM MCP declaration: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        );
      return result.data.name;
    });
  }
  return input;
}
