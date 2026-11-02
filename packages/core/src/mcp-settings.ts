import { z } from "zod";

export const McpSettingsSchema = z
  .object({
    default_mode: z.enum(["meta", "full"]).default("meta"),
  })
  .strict();

export type McpSettings = z.infer<typeof McpSettingsSchema>;
