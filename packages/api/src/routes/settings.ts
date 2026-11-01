import { createRoute, z } from "@hono/zod-openapi";
import { ChatSettingsSchema } from "@orc/core/chat";
import { loadConfig, updateGlobalConfig } from "@orc/core/config";
import { McpSettingsSchema } from "@orc/core/mcp-settings";
import { createRouter } from "../lib/router.js";

const app = createRouter();
const mcpResponse = {
  200: {
    description: "MCP defaults and prompts; no credentials",
    content: { "application/json": { schema: McpSettingsSchema } },
  },
};

app.openapi(
  createRoute({
    method: "get",
    path: "/settings/mcp",
    tags: ["System"],
    summary: "Read MCP connection defaults and prompts",
    responses: mcpResponse,
  }),
  (c) =>
    c.json(
      McpSettingsSchema.parse({
        default_mode: loadConfig().mcp.default_mode,
        prompts: loadConfig().mcp.prompts,
      }),
    ),
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/settings/mcp",
    tags: ["System"],
    summary: "Persist MCP connection defaults and prompts",
    request: { body: { content: { "application/json": { schema: McpSettingsSchema.partial() } } } },
    responses: mcpResponse,
  }),
  (c) => {
    const settings = c.req.valid("json");
    const config = updateGlobalConfig((raw) => {
      raw.mcp = { ...loadConfig().mcp, ...settings };
    });
    return c.json(
      McpSettingsSchema.parse({
        default_mode: config.mcp.default_mode,
        prompts: config.mcp.prompts,
      }),
    );
  },
);
const PreferencesSchema = z
  .object({
    theme: z.enum(["dark", "light"]).optional(),
    terminal_font: z.string().trim().max(200).optional(),
    attention_retention_hours: z.number().int().min(1).max(8760).optional(),
    chat: ChatSettingsSchema.optional(),
  })
  .strict();
const response = {
  200: {
    description: "Persistent workspace preferences; credentials are never returned",
    content: { "application/json": { schema: PreferencesSchema } },
  },
};

app.openapi(
  createRoute({
    method: "get",
    path: "/settings",
    tags: ["System"],
    summary: "Read workspace preferences",
    responses: response,
  }),
  (c) => c.json(PreferencesSchema.parse(loadConfig().preferences)),
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/settings",
    tags: ["System"],
    summary: "Persist workspace preferences in the global config file",
    request: { body: { content: { "application/json": { schema: PreferencesSchema } } } },
    responses: response,
  }),
  (c) => {
    const preferences = c.req.valid("json");
    const config = updateGlobalConfig((raw) => {
      const existing = PreferencesSchema.parse(raw.preferences ?? {});
      raw.preferences = { ...existing, ...preferences };
    });
    return c.json(PreferencesSchema.parse(config.preferences));
  },
);

export { app as settingsRouter };
