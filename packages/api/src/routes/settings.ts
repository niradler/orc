import { createRoute, z } from "@hono/zod-openapi";
import { ChatSettingsSchema } from "@orc/core/chat";
import { AGENT_ID_PATTERN, ProviderPathsSchema } from "@orc/core/coding-agents";
import { loadConfig, OrcConfigSchema, updateGlobalConfig } from "@orc/core/config";
import { McpServerSettingsSchema } from "@orc/core/mcp-prompts";
import { AuditLog } from "@orc/db/audit";
import { getSqlite } from "@orc/db/client";
import { McpPromptStore } from "@orc/db/mcp-prompts";
import { createRouter } from "../lib/router.js";

const app = createRouter();
const mcpResponse = {
  200: {
    description: "MCP defaults and prompts; no credentials",
    content: { "application/json": { schema: McpServerSettingsSchema } },
  },
};
const mcpSettings = () =>
  McpServerSettingsSchema.parse({
    default_mode: loadConfig().mcp.default_mode,
    prompts: new McpPromptStore(getSqlite()).list(),
  });

app.openapi(
  createRoute({
    method: "get",
    path: "/settings/mcp",
    tags: ["System"],
    summary: "Read MCP connection defaults and prompts",
    responses: mcpResponse,
  }),
  (c) => c.json(mcpSettings()),
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/settings/mcp",
    tags: ["System"],
    summary: "Persist MCP connection defaults and prompts",
    request: {
      body: { content: { "application/json": { schema: McpServerSettingsSchema.partial() } } },
    },
    responses: mcpResponse,
  }),
  (c) => {
    const { prompts, ...settings } = c.req.valid("json");
    if (Object.keys(settings).length)
      updateGlobalConfig((raw) => {
        raw.mcp = { ...(raw.mcp as Record<string, unknown> | undefined), ...settings };
      });
    if (prompts) new McpPromptStore(getSqlite()).replace(prompts);
    return c.json(mcpSettings());
  },
);

const SecuritySettingsSchema = OrcConfigSchema.shape.api
  .unwrap()
  .pick({ session_days: true, cors_origins: true })
  .strict();
const securityResponse = {
  200: {
    description: "Browser session and cross-origin settings; the API secret is never returned",
    content: { "application/json": { schema: SecuritySettingsSchema } },
  },
};
const securitySettings = () => {
  const { session_days, cors_origins } = loadConfig().api;
  return { session_days, cors_origins };
};

app.openapi(
  createRoute({
    method: "get",
    path: "/settings/security",
    tags: ["System"],
    summary: "Read browser session and cross-origin settings",
    responses: securityResponse,
  }),
  (c) => c.json(securitySettings()),
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/settings/security",
    tags: ["System"],
    summary: "Persist browser session and cross-origin settings",
    description:
      "Environment variables ORC_API_SESSION_DAYS and ORC_API_CORS_ORIGINS take precedence over saved values.",
    request: {
      body: { content: { "application/json": { schema: SecuritySettingsSchema.partial() } } },
    },
    responses: securityResponse,
  }),
  (c) => {
    const settings = c.req.valid("json");
    updateGlobalConfig((raw) => {
      raw.api = { ...(raw.api as Record<string, unknown> | undefined), ...settings };
    });
    return c.json(securitySettings());
  },
);

const PreferencesSchema = z
  .object({
    theme: z.enum(["dark", "light"]).optional(),
    terminal_font: z.string().trim().max(200).optional(),
    attention_retention_hours: z.number().int().min(1).max(8760).optional(),
    notification_retention_days: z.number().int().min(1).max(3650).optional(),
    audit_retention_days: z.number().int().min(1).max(3650).optional(),
    chat: ChatSettingsSchema.optional(),
    agents: z.array(z.string().regex(AGENT_ID_PATTERN)).max(64).optional(),
    provider_paths: ProviderPathsSchema.optional(),
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
    const previous = loadConfig().preferences;
    const config = updateGlobalConfig((raw) => {
      const existing = PreferencesSchema.parse(raw.preferences ?? {});
      raw.preferences = { ...existing, ...preferences };
    });
    const before = {
      notification_retention_days: previous.notification_retention_days ?? 30,
      audit_retention_days: previous.audit_retention_days ?? 90,
    };
    const after = {
      notification_retention_days: config.preferences.notification_retention_days ?? 30,
      audit_retention_days: config.preferences.audit_retention_days ?? 90,
    };
    if (
      before.notification_retention_days !== after.notification_retention_days ||
      before.audit_retention_days !== after.audit_retention_days
    )
      new AuditLog(getSqlite()).record({
        action: "settings.retention_changed",
        subject_ids: [],
        actor: c.req.header("x-orc-actor-name")?.slice(0, 80) ?? null,
        session_id: c.req.header("x-orc-session-id")?.slice(0, 200) ?? null,
        snapshot: { before, after },
      });
    return c.json(PreferencesSchema.parse(config.preferences));
  },
);

export { app as settingsRouter };
