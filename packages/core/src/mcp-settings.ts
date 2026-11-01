import { z } from "zod";

export const McpPromptSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(1000).default(""),
    content: z.string().trim().min(1).max(30000),
    include_ui_catalog: z.boolean().default(false),
  })
  .strict();

export const DEFAULT_MCP_PROMPTS = [
  {
    name: "render-ui",
    title: "Render ORC components",
    description: "Answer a web chat request using the current ORC UI catalog.",
    content:
      "For a webchat turn, answer with an orc-ui JSON block using the catalog below. Resolve real entity ids with ORC tools first. For other sources, answer in Markdown.",
    include_ui_catalog: true,
  },
];

export const McpSettingsSchema = z
  .object({
    default_mode: z.enum(["meta", "full"]).default("meta"),
    prompts: z
      .array(McpPromptSchema)
      .max(50)
      .refine((prompts) => new Set(prompts.map((prompt) => prompt.name)).size === prompts.length, {
        message: "Prompt names must be unique",
      })
      .default(DEFAULT_MCP_PROMPTS),
  })
  .strict();

export type McpSettings = z.infer<typeof McpSettingsSchema>;
