import { createHash } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { ChatSettingsSchema, ComposerProfilesSchema, FavoriteModelsSchema } from "@orc/core/chat";
import { AGENT_ID_PATTERN, ProviderPathsSchema } from "@orc/core/coding-agents";
import { loadConfig, OrcConfigSchema, updateGlobalConfig } from "@orc/core/config";
import { ConflictError } from "@orc/core/errors";
import { McpServerSettingsSchema } from "@orc/core/mcp-prompts";
import {
  applyProviderPreferencePatch,
  providerChatDefaults,
  readProviderSettings,
  saveProviderSettings,
} from "@orc/core/provider-service";
import { ProviderAccountsSchema, ProviderSettingsSchema } from "@orc/core/providers";
import { getSqlite } from "@orc/db/client";
import { McpPromptStore } from "@orc/db/mcp-prompts";
import { diffSummary, recordAudit } from "../lib/audit-actor.js";
import { createRouter } from "../lib/router.js";
import { readProviderAccounts } from "../provider-accounts.js";

const app = createRouter();
const providerResponse = {
  200: {
    description: "Named coding providers; secret environment values are never returned",
    content: { "application/json": { schema: ProviderSettingsSchema } },
  },
};
app.openapi(
  createRoute({
    method: "get",
    path: "/settings/providers",
    tags: ["System"],
    summary: "Read named coding providers and the default provider",
    responses: providerResponse,
  }),
  (c) => c.json(readProviderSettings()),
);
app.openapi(
  createRoute({
    method: "put",
    path: "/settings/providers",
    tags: ["System"],
    summary: "Save named providers with encrypted write-only environment secrets",
    request: { body: { content: { "application/json": { schema: ProviderSettingsSchema } } } },
    responses: providerResponse,
  }),
  (c) => {
    const saved = saveProviderSettings(c.req.valid("json"));
    recordAudit(c, {
      action: "settings.providers_changed",
      subject_ids: [],
      snapshot: { providers: saved.providers.map((provider) => provider.name).slice(0, 50) },
    });
    return c.json(saved);
  },
);
app.openapi(
  createRoute({
    method: "get",
    path: "/settings/providers/accounts",
    tags: ["System"],
    summary: "Read the CLI account behind each coding provider, without credentials",
    responses: {
      200: {
        description: "Account identity read from the CLI's own config directory",
        content: { "application/json": { schema: ProviderAccountsSchema } },
      },
    },
  }),
  async (c) => c.json({ accounts: await readProviderAccounts() }),
);
const mcpResponse = {
  200: {
    description: "MCP defaults and prompts; no credentials",
    content: { "application/json": { schema: McpServerSettingsSchema } },
  },
};
const mcpSettings = () =>
  McpServerSettingsSchema.parse({
    default_mode: loadConfig().mcp.default_mode,
    code_execution: loadConfig().mcp.code_execution,
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
      body: {
        content: {
          "application/json": {
            schema: McpServerSettingsSchema.partial().extend({
              default_mode: McpServerSettingsSchema.shape.default_mode.unwrap().optional(),
              code_execution: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: mcpResponse,
  }),
  (c) => {
    const { prompts, ...settings } = c.req.valid("json");
    const previousMode = loadConfig().mcp.default_mode;
    const previousCodeExecution = loadConfig().mcp.code_execution;
    const previousPrompts = prompts ? JSON.stringify(new McpPromptStore(getSqlite()).list()) : null;
    if (Object.keys(settings).length)
      updateGlobalConfig((raw) => {
        raw.mcp = { ...(raw.mcp as Record<string, unknown> | undefined), ...settings };
      });
    if (prompts) new McpPromptStore(getSqlite()).replace(prompts);
    const mode = loadConfig().mcp.default_mode;
    const codeExecution = loadConfig().mcp.code_execution;
    const promptsChanged =
      prompts !== undefined &&
      previousPrompts !== JSON.stringify(new McpPromptStore(getSqlite()).list());
    if (mode !== previousMode || codeExecution !== previousCodeExecution || promptsChanged)
      recordAudit(c, {
        action: "settings.mcp_changed",
        subject_ids: [],
        snapshot: {
          ...(mode !== previousMode ? { default_mode: { before: previousMode, after: mode } } : {}),
          ...(codeExecution !== previousCodeExecution
            ? { code_execution: { before: previousCodeExecution, after: codeExecution } }
            : {}),
          ...(promptsChanged ? { prompts: prompts?.length } : {}),
        },
      });
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
    const before = securitySettings();
    updateGlobalConfig((raw) => {
      raw.api = { ...(raw.api as Record<string, unknown> | undefined), ...settings };
    });
    const after = securitySettings();
    const changed = Object.keys(settings).filter(
      (key) =>
        JSON.stringify(before[key as keyof typeof before]) !==
        JSON.stringify(after[key as keyof typeof after]),
    );
    if (changed.length)
      recordAudit(c, {
        action: "settings.security_changed",
        subject_ids: [],
        snapshot: { changed, before, after },
      });
    return c.json(after);
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
    favorite_models: FavoriteModelsSchema.optional(),
    composer_profiles: ComposerProfilesSchema.optional(),
    composer_revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .openapi({
        description:
          "Revision of favorite_models and composer_profiles from the last read; required when saving either. A stale revision returns 409.",
      }),
    agents: z.array(z.string().regex(AGENT_ID_PATTERN)).max(64).optional(),
    provider_paths: ProviderPathsSchema.optional(),
    setup_dismissed: z.boolean().optional().openapi({
      description:
        "The first-run setup screen was dismissed; it stays hidden while no project exists.",
    }),
  })
  .strict();
function composerRevision(preferences: Record<string, unknown> | undefined): string {
  return createHash("sha256")
    .update(
      JSON.stringify([preferences?.favorite_models ?? [], preferences?.composer_profiles ?? []]),
    )
    .digest("hex");
}
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
  (c) =>
    c.json(
      PreferencesSchema.parse({
        ...loadConfig().preferences,
        ...(loadConfig().providers ? { chat: providerChatDefaults() } : {}),
        composer_revision: composerRevision(loadConfig().preferences),
      }),
    ),
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
    const { composer_revision: revision, ...preferences } = c.req.valid("json");
    const previous = loadConfig().preferences;
    const config = updateGlobalConfig((raw) => {
      const existing = PreferencesSchema.parse(raw.preferences ?? {});
      if (
        (preferences.favorite_models || preferences.composer_profiles) &&
        revision !== composerRevision(existing)
      )
        throw new ConflictError("Favorites or profiles changed elsewhere. Reload and try again.");
      raw.preferences = { ...existing, ...preferences };
      applyProviderPreferencePatch(raw, preferences);
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
      recordAudit(c, {
        action: "settings.retention_changed",
        subject_ids: [],
        snapshot: { before, after },
      });
    const others = Object.fromEntries(
      Object.entries(preferences).filter(([key]) => !key.endsWith("_retention_days")),
    );
    const diff = diffSummary(
      previous as Record<string, unknown>,
      others,
      config.preferences as Record<string, unknown>,
    );
    if (diff.changed.length)
      recordAudit(c, { action: "settings.preferences_changed", subject_ids: [], snapshot: diff });
    return c.json(
      PreferencesSchema.parse({
        ...config.preferences,
        composer_revision: composerRevision(config.preferences),
      }),
    );
  },
);

export { app as settingsRouter };
