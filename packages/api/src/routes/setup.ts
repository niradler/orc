import { createRoute, z } from "@hono/zod-openapi";
import { readProviderSettings } from "@orc/core/provider-service";
import { createRouter } from "../lib/router.js";
import { readSetupAgents, setupAgentIds, suggestSetupProjects } from "../setup-status.js";

const app = createRouter();

const SetupAgentSchema = z
  .object({
    agent: z.enum(setupAgentIds()),
    label: z.string(),
    installed: z.boolean(),
    path: z.string().nullable(),
    version: z.string().nullable(),
    signed_in: z.boolean().nullable().openapi({
      description: "Null when the credential store cannot be inspected (e.g. macOS keychain).",
    }),
    account_label: z.string().nullable(),
    fix: z
      .object({ label: z.string(), command: z.string() })
      .nullable()
      .openapi({ description: "The one action that unblocks this agent, when one exists." }),
  })
  .openapi("SetupAgent");

const SetupSuggestionSchema = z
  .object({
    path: z.string(),
    name: z.string(),
    agents: z.array(z.string()),
    sessions: z.number().int(),
    last_activity_at: z.string().datetime(),
  })
  .openapi("SetupProjectSuggestion");

const statusRoute = createRoute({
  method: "get",
  path: "/setup",
  tags: ["System"],
  summary: "First-run status: detected agents and projects suggested from their session history",
  description:
    "Powers the web first-run screen: which coding agents are installed and signed in on the " +
    "ORC host, which folders their discovered sessions were last used in, and the current " +
    "default agent. Detection is file- and PATH-based; it does not start any agent.",
  responses: {
    200: {
      description: "First-run setup status",
      content: {
        "application/json": {
          schema: z
            .object({
              agents: z.array(SetupAgentSchema),
              suggestions: z.array(SetupSuggestionSchema),
              default_agent: z.string().nullable().openapi({
                description: "Agent of the default provider profile (Settings → Providers).",
              }),
            })
            .openapi("SetupStatus"),
        },
      },
    },
  },
});

app.openapi(statusRoute, async (c) => {
  const [agents, suggestions] = await Promise.all([readSetupAgents(), suggestSetupProjects()]);
  const providers = readProviderSettings();
  const defaultProfile = providers.providers.find(
    (profile) => profile.id === providers.default_provider_id,
  );
  return c.json({
    agents,
    suggestions,
    default_agent: defaultProfile?.agent ?? null,
  });
});

export { app as setupRouter };
