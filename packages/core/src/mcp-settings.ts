import { z } from "zod";

export const MCP_MODES = ["full", "meta"] as const;

export const McpSettingsSchema = z
  .object({
    default_mode: z.enum(MCP_MODES).default("meta"),
    code_execution: z.boolean().default(true),
  })
  .strict();

export type McpSettings = z.infer<typeof McpSettingsSchema>;
