import { z } from "zod";

export const MCP_MODES = ["full", "meta", "code"] as const;

export const McpSettingsSchema = z
  .object({
    default_mode: z.enum(MCP_MODES).default("meta"),
  })
  .strict();

export type McpSettings = z.infer<typeof McpSettingsSchema>;
