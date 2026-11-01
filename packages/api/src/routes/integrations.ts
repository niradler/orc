import { createRoute, z } from "@hono/zod-openapi";
import { ConflictError, OrcError } from "@orc/core/errors";
import {
  createSpecClient,
  formatPromptName,
  formatResourceUri,
  McpAuthRequiredError,
  matchFilter,
  memoryRegistryStore,
  type NamedEntry,
  operationId,
  operationSchema,
  operations,
  requireOperation,
  resolveResourceUri,
  type SpecClient,
  type SpecDocument,
  type SpecOperation,
  type SpecSource,
} from "api-spec-cli";
import { createRouter } from "../lib/router.js";

const app = createRouter();

// ORC proxies the spec-cli SDK: its registry, cache and OAuth tokens (SPEC_HOME) are the source of
// truth shared with the `spec` CLI. ORC keeps no copy of a connection.

const tags = ["Integrations"];
const ok = <T extends z.ZodType>(description: string, schema: T) => ({
  200: { description, content: { "application/json": { schema } } },
});
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
const SpecName = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "Use only letters, numbers, hyphens and underscores")
  .max(100);
const nameParam = z.object({ name: SpecName });
// Resources and prompts share the tool namespace as `resource:<uri>` and `prompt:<name>`, and a
// resource URI may run long.
const toolParam = z.object({ name: SpecName, tool: z.string().min(1).max(8200) });

const StringMap = z.record(z.string(), z.string());
const sourceBase = {
  description: z.string().max(500).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  disabledTools: z.array(z.string().min(1)).optional(),
};
const remoteSource = <T extends "http" | "sse">(type: T) =>
  z.object({
    type: z.literal(type),
    url: z.string().min(1),
    auth: z.string().optional(),
    headers: StringMap.optional(),
    oauthFlow: z.enum(["browser", "device", "client_credentials"]).optional(),
    oauthClientId: z.string().optional(),
    oauthClientSecret: z.string().optional(),
    oauthCallbackPort: z.number().int().min(1).max(65535).optional(),
    ...sourceBase,
  });
const SourceSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("openapi"),
      source: z.string().min(1),
      baseUrl: z.string().optional(),
      auth: z.string().optional(),
      headers: StringMap.optional(),
      ...sourceBase,
    }),
    z.object({
      type: z.literal("graphql"),
      source: z.string().min(1),
      auth: z.string().optional(),
      headers: StringMap.optional(),
      ...sourceBase,
    }),
    remoteSource("http"),
    remoteSource("sse"),
    z.object({
      type: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      env: StringMap.optional(),
      ...sourceBase,
    }),
  ])
  .openapi("IntegrationConnectionSource");

const ConnectionSchema = z
  .object({
    name: z.string(),
    type: z.string().nullable(),
    description: z.string().nullable(),
    enabled: z.boolean(),
  })
  .openapi("IntegrationConnection");
// The full configuration, secrets included: callers hold the API secret, and the editor masks them.
const ConnectionDetailSchema = z
  .object({ name: z.string(), enabled: z.boolean(), source: SourceSchema })
  .openapi("IntegrationConnectionDetail");
const ToolSchema = z
  .object({ id: z.string(), description: z.string(), enabled: z.boolean() })
  .openapi("IntegrationTool");
const ToolDetailSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .openapi("IntegrationToolDetail");
const ToolResultSchema = z
  .object({
    content: z.array(z.record(z.string(), z.unknown())),
    isError: z.boolean().optional(),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("IntegrationToolResult");

const ResourceSchema = z
  .object({
    uri: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    mimeType: z.string().nullable(),
    enabled: z.boolean(),
  })
  .openapi("IntegrationResource");
const ResourceTemplateSchema = ResourceSchema.omit({ uri: true })
  .extend({ uriTemplate: z.string() })
  .openapi("IntegrationResourceTemplate");
const ResourceContentsSchema = z
  .object({ contents: z.array(z.record(z.string(), z.unknown())) })
  .openapi("IntegrationResourceContents");
const PromptSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    arguments: z.array(
      z.object({ name: z.string(), description: z.string().nullable(), required: z.boolean() }),
    ),
    enabled: z.boolean(),
  })
  .openapi("IntegrationPrompt");
const PromptResultSchema = z
  .object({
    description: z.string().optional(),
    messages: z.array(z.record(z.string(), z.unknown())),
  })
  .openapi("IntegrationPromptResult");
// Set when the server advertises the feature but listing it failed; tools keep working regardless.
const featureError = z.string().nullable();

/**
 * Runs one SDK call with a fresh client. spec-cli reports every failure as a plain Error, so a
 * missing spec or tool becomes a 404 and anything else `failure` (400 for edits, 503 for reaching a
 * server).
 */
async function withSpecs<T>(failure: 400 | 503, run: (client: SpecClient) => Promise<T> | T) {
  const client = createSpecClient();
  try {
    return await run(client);
  } catch (error) {
    if (error instanceof OrcError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // The catalog reports disabled or filtered tools the same way as missing ones.
    if (/^(No spec named|Unavailable (spec|tool|resource|prompt)$)/.test(message))
      throw new OrcError(message, "NOT_FOUND", 404);
    throw new OrcError(message, failure === 400 ? "SPEC_ERROR" : "SPEC_UNAVAILABLE", failure);
  } finally {
    await client.close();
  }
}

/** Rebuilds the source `spec add` accepts from a stored entry, so an edit round-trips every field. */
function sourceOf(entry: NamedEntry): SpecSource {
  const description = entry.description || undefined;
  if (entry._section !== "mcp") {
    const config = entry.config ?? {};
    const common = {
      source: entry.source,
      auth: config.auth ?? undefined,
      headers: config.headers,
      allowedTools: config.allowedTools,
      disabledTools: config.disabledTools,
      description,
    };
    return toSource(
      entry._section === "openapi"
        ? { type: "openapi", baseUrl: config.baseUrl ?? undefined, ...common }
        : { type: "graphql", ...common },
    );
  }
  const filter = { allowedTools: entry.allowedTools, disabledTools: entry.disabledTools };
  if (entry.type === "stdio" || "command" in entry) {
    const stdio = entry as Extract<NamedEntry, { type: "stdio" }>;
    return toSource({
      type: "stdio",
      command: stdio.command,
      args: stdio.args,
      cwd: stdio.cwd,
      env: stdio.env,
      ...filter,
      description,
    });
  }
  return toSource({
    type: entry.type ?? "http",
    url: entry.url,
    headers: entry.headers,
    oauthFlow: entry.oauthFlow,
    oauthClientId: entry.oauthClientId,
    oauthCallbackPort: entry.oauthCallbackPort,
    ...filter,
    description,
  });
}

/** spec-cli stores whatever keys it is given, so unset fields are dropped rather than kept as undefined. */
function toSource(source: z.infer<typeof SourceSchema>): SpecSource {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as unknown as SpecSource;
}

/** spec-cli's own allow/deny rule for a tool name (catalog.entryAllows). */
function allows(source: SpecSource, tool: string) {
  if (source.allowedTools?.length && !source.allowedTools.some((p) => matchFilter(p, tool)))
    return false;
  return !source.disabledTools?.some((p) => matchFilter(p, tool));
}

/** `spec add` always stores an enabled entry; an edit keeps the connection's on/off state. */
function save(client: SpecClient, name: string, source: SpecSource, enabled: boolean) {
  client.specs.add(name, source);
  if (!enabled) client.specs.disable(name);
}

/**
 * Loads every operation of a connection with its stored source. spec-cli drops filtered tools while
 * fetching and refuses disabled specs, so the entry is loaded from a one-entry in-memory registry,
 * enabled and unfiltered. It keeps its name, so OAuth tokens and the spec cache still apply.
 */
async function loadAll(client: SpecClient, name: string) {
  const { _section, name: _, ...entry } = client.specs.get(name);
  const source = sourceOf({ ...entry, _section, name } as NamedEntry);
  const stored =
    "config" in entry
      ? {
          ...entry,
          config: { ...entry.config, allowedTools: undefined, disabledTools: undefined },
        }
      : { ...entry, allowedTools: undefined, disabledTools: undefined };
  const unfiltered = createSpecClient({
    registry: memoryRegistryStore({ [_section]: { [name]: { ...stored, enabled: true } } }),
  });
  try {
    return { spec: (await unfiltered.operations.load(name)).spec, source };
  } finally {
    await unfiltered.close();
  }
}

/** An MCP server's resources or prompts; other spec types and servers without the feature have none. */
function mcpFeature(spec: SpecDocument, feature: "resources" | "prompts") {
  return spec.type === "mcp" ? { spec, error: spec.featureErrors?.[feature] ?? null } : null;
}

const detail = (entry: NamedEntry) => ({
  name: entry.name,
  enabled: entry.enabled !== false,
  source: sourceOf(entry),
});

const describeOperation = (operation: SpecOperation) =>
  ("description" in operation && operation.description) ||
  ("summary" in operation && operation.summary) ||
  "";

const isSubscription = (operation: SpecOperation) =>
  "kind" in operation && operation.kind === "subscription";

app.openapi(
  createRoute({
    method: "get",
    path: "/integrations/connections",
    tags,
    summary: "List specs registered in spec-cli",
    responses: ok(
      "Registered connections",
      z.object({ connections: z.array(ConnectionSchema) }).openapi("IntegrationConnectionList"),
    ),
  }),
  async (c) =>
    c.json({
      connections: await withSpecs(400, (client) =>
        // Full entries carry the registry section (openapi/graphql/mcp), which the compact
        // listing drops; only the fields below are copied out.
        client.specs.list({ compact: false }).map((spec) => ({
          name: spec.name,
          type: spec._section === "mcp" ? (spec.type ?? null) : spec._section,
          description: spec.description ?? null,
          enabled: spec.enabled !== false,
        })),
      ),
    }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/integrations/connections",
    tags,
    summary: "Register a spec in spec-cli",
    request: json(z.object({ name: SpecName, source: SourceSchema })),
    responses: ok("Created connection", ConnectionDetailSchema),
  }),
  async (c) => {
    const { name, source } = c.req.valid("json");
    return c.json(
      await withSpecs(400, (client) => {
        if (client.specs.list().some((spec) => spec.name === name))
          throw new ConflictError(`A connection named ${name} already exists`);
        return detail(client.specs.add(name, toSource(source)).entry);
      }),
    );
  },
);

// spec-cli and ORC may each bundle their own MCP SDK copy, so the auth errors are matched by name.
const isAuthRequired = (error: unknown) =>
  error instanceof McpAuthRequiredError ||
  (error instanceof Error && error.name === "UnauthorizedError");

app.openapi(
  createRoute({
    method: "post",
    path: "/integrations/connections/test",
    tags,
    summary: "Check that an unsaved connection reaches its server",
    description:
      "Loads the source from a throwaway in-memory registry, so nothing is saved. The name lets an " +
      "edit reuse the connection's stored OAuth tokens; servers that need a sign-in report `auth_required`.",
    request: json(z.object({ name: SpecName, source: SourceSchema })),
    responses: ok(
      "Test result",
      z
        .object({
          status: z.enum(["connected", "auth_required", "failed"]),
          count: z.number().nullable(),
          message: z.string().nullable(),
        })
        .openapi("IntegrationTestResult"),
    ),
  }),
  async (c) => {
    const { name, source } = c.req.valid("json");
    // A typed secret would be written to the token file by `add`; the test never stores one.
    const { oauthClientSecret: _, ...rest } = source as typeof source & {
      oauthClientSecret?: string;
    };
    const client = createSpecClient({ registry: memoryRegistryStore() });
    try {
      client.specs.add(name, toSource(rest as z.infer<typeof SourceSchema>));
      const { spec } = await client.operations.load(name, { refresh: true });
      return c.json({
        status: "connected" as const,
        count: operations(spec).length,
        message: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({
        status: isAuthRequired(error) ? ("auth_required" as const) : ("failed" as const),
        count: null,
        message,
      });
    } finally {
      await client.close();
    }
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/integrations/connections/{name}",
    tags,
    summary: "Get a connection's full configuration",
    request: { params: nameParam },
    responses: ok("Connection", ConnectionDetailSchema),
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    return c.json(await withSpecs(400, (client) => detail(client.specs.get(name))));
  },
);

app.openapi(
  createRoute({
    method: "put",
    path: "/integrations/connections/{name}",
    tags,
    summary: "Replace a connection's configuration, keeping its enabled state and OAuth tokens",
    request: { params: nameParam, ...json(z.object({ source: SourceSchema })) },
    responses: ok("Updated connection", ConnectionDetailSchema),
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const { source } = c.req.valid("json");
    return c.json(
      await withSpecs(400, (client) => {
        save(client, name, toSource(source), client.specs.get(name).enabled !== false);
        return detail(client.specs.get(name));
      }),
    );
  },
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/integrations/connections/{name}",
    tags,
    summary: "Enable or disable a connection",
    request: { params: nameParam, ...json(z.object({ enabled: z.boolean() })) },
    responses: ok("Updated connection", ConnectionDetailSchema),
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const { enabled } = c.req.valid("json");
    return c.json(
      await withSpecs(400, (client) => {
        if (enabled) client.specs.enable(name);
        else client.specs.disable(name);
        return detail(client.specs.get(name));
      }),
    );
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/integrations/connections/{name}",
    tags,
    summary: "Remove a connection with its cached spec and OAuth tokens",
    request: { params: nameParam },
    responses: { 204: { description: "Removed" } },
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    await withSpecs(400, (client) => client.specs.remove(name));
    return c.body(null, 204);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/integrations/connections/{name}/refresh",
    tags,
    summary: "Fetch the connection's spec or tool list again",
    request: { params: nameParam },
    responses: ok(
      "Refreshed",
      z
        .object({ name: z.string(), type: z.string(), count: z.number() })
        .openapi("IntegrationRefreshResult"),
    ),
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    return c.json(await withSpecs(503, (client) => client.specs.refresh(name)));
  },
);

// Sign-in runs through the browser: ORC starts it with the web page that will receive the callback,
// and that page hands the code back. spec-cli keeps the PKCE verifier keyed by state between the two.
app.openapi(
  createRoute({
    method: "post",
    path: "/integrations/connections/{name}/authorize",
    tags,
    summary: "Start an OAuth sign-in for a remote MCP connection",
    description:
      "Returns `redirect` with the URL to open, or `authorized` when the server needs no sign-in " +
      "or uses the client-credentials flow. The provider sends the browser back to `redirectUrl`.",
    request: { params: nameParam, ...json(z.object({ redirectUrl: z.string().url().max(2000) })) },
    responses: ok(
      "Sign-in started",
      z
        .object({
          status: z.enum(["authorized", "redirect"]),
          authorizationUrl: z.string().nullable(),
        })
        .openapi("IntegrationAuthorization"),
    ),
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const { redirectUrl } = c.req.valid("json");
    const start = await withSpecs(503, (client) =>
      client.specs.startAuthorization(name, { redirectUrl }),
    );
    return c.json({
      status: start.status,
      authorizationUrl: start.status === "redirect" ? start.authorizationUrl : null,
    });
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/integrations/connections/{name}/authorize/callback",
    tags,
    summary: "Finish an OAuth sign-in with the code the provider returned",
    request: {
      params: nameParam,
      ...json(z.object({ code: z.string().min(1).max(4000), state: z.string().min(1).max(500) })),
    },
    responses: { 204: { description: "Signed in" } },
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const callback = c.req.valid("json");
    await withSpecs(400, (client) => client.specs.finishAuthorization(name, callback));
    return c.body(null, 204);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/integrations/connections/{name}/authorize",
    tags,
    summary: "Sign out: drop the connection's stored OAuth tokens",
    request: { params: nameParam },
    responses: { 204: { description: "Signed out" } },
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    await withSpecs(400, (client) => client.specs.revoke(name));
    return c.body(null, 204);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/integrations/connections/{name}/tools",
    tags,
    summary: "List a connection's tools, including those its filters disable",
    request: { params: nameParam },
    responses: ok("Tools", z.object({ tools: z.array(ToolSchema) }).openapi("IntegrationToolList")),
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    return c.json({
      tools: await withSpecs(503, async (client) => {
        const { spec, source } = await loadAll(client, name);
        return operations(spec)
          .filter((operation) => !isSubscription(operation))
          .map((operation) => {
            const id = operationId(spec, operation);
            return { id, description: describeOperation(operation), enabled: allows(source, id) };
          });
      }),
    });
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/integrations/connections/{name}/tools/{tool}",
    tags,
    summary: "Describe a tool and its input schema",
    request: { params: toolParam },
    responses: ok("Tool", ToolDetailSchema),
  }),
  async (c) => {
    const { name, tool } = c.req.valid("param");
    return c.json(
      await withSpecs(503, async (client) => {
        const { spec, source } = await loadAll(client, name);
        const operation = requireOperation(spec, tool, { exact: true });
        const id = operationId(spec, operation);
        return {
          id,
          description: describeOperation(operation),
          enabled: allows(source, id),
          inputSchema: operationSchema(spec, operation),
        };
      }),
    );
  },
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/integrations/connections/{name}/tools/{tool}",
    tags,
    summary: "Enable or disable one tool through the connection's disabledTools filter",
    request: { params: toolParam, ...json(z.object({ enabled: z.boolean() })) },
    responses: ok("Updated tool", ToolSchema.omit({ description: true })),
  }),
  async (c) => {
    const { name, tool } = c.req.valid("param");
    const { enabled } = c.req.valid("json");
    return c.json(
      await withSpecs(400, (client) => {
        const entry = client.specs.get(name);
        const source = sourceOf(entry);
        const disabledTools = (source.disabledTools ?? []).filter(
          (pattern) => pattern.toLowerCase() !== tool.toLowerCase(),
        );
        if (!enabled) disabledTools.push(tool);
        const next = { ...source, disabledTools };
        if (allows(next, tool) !== enabled)
          throw new ConflictError(
            `${tool} is matched by a tool filter pattern; edit the connection's filters instead`,
          );
        save(client, name, next, entry.enabled !== false);
        return { id: tool, enabled };
      }),
    );
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/integrations/connections/{name}/tools/{tool}/invoke",
    tags,
    summary: "Call a tool through spec-cli's catalog, as an agent would",
    request: {
      params: toolParam,
      ...json(z.object({ args: z.record(z.string(), z.unknown()).optional().default({}) })),
    },
    responses: ok("Tool result", ToolResultSchema),
  }),
  async (c) => {
    const { name, tool } = c.req.valid("param");
    const { args } = c.req.valid("json");
    return c.json(
      (await withSpecs(503, (client) => client.tools.call(`${name}.${tool}`, args))) as z.infer<
        typeof ToolResultSchema
      >,
    );
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/integrations/connections/{name}/resources",
    tags,
    summary:
      "List an MCP connection's resources and templates, including those its filters disable",
    request: { params: nameParam },
    responses: ok(
      "Resources",
      z
        .object({
          resources: z.array(ResourceSchema),
          templates: z.array(ResourceTemplateSchema),
          error: featureError,
        })
        .openapi("IntegrationResourceList"),
    ),
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    return c.json(
      await withSpecs(503, async (client) => {
        const { spec, source } = await loadAll(client, name);
        const mcp = mcpFeature(spec, "resources");
        return {
          resources: (mcp?.spec.resources ?? []).map((resource) => ({
            ...resource,
            enabled: allows(source, `resource:${resource.uri}`),
          })),
          templates: (mcp?.spec.resourceTemplates ?? []).map((template) => ({
            ...template,
            enabled: allows(source, `resource:${template.uriTemplate}`),
          })),
          error: mcp?.error ?? null,
        };
      }),
    );
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/integrations/connections/{name}/resources/read",
    tags,
    summary: "Read a resource, or expand a template and read it, through spec-cli's catalog",
    request: {
      params: nameParam,
      ...json(
        z.object({
          uri: z.string().min(1).max(8192),
          vars: StringMap.optional().default({}),
        }),
      ),
    },
    responses: ok("Resource contents", ResourceContentsSchema),
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const { uri, vars } = c.req.valid("json");
    return c.json(
      (await withSpecs(503, async (client) => {
        const { spec } = await client.operations.load(name);
        const concrete = resolveResourceUri(spec, uri, vars);
        return client.tools.readResource(formatResourceUri(name, concrete));
      })) as z.infer<typeof ResourceContentsSchema>,
    );
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/integrations/connections/{name}/prompts",
    tags,
    summary: "List an MCP connection's prompts, including those its filters disable",
    request: { params: nameParam },
    responses: ok(
      "Prompts",
      z
        .object({ prompts: z.array(PromptSchema), error: featureError })
        .openapi("IntegrationPromptList"),
    ),
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    return c.json(
      await withSpecs(503, async (client) => {
        const { spec, source } = await loadAll(client, name);
        const mcp = mcpFeature(spec, "prompts");
        return {
          prompts: (mcp?.spec.prompts ?? []).map((prompt) => ({
            ...prompt,
            enabled: allows(source, `prompt:${prompt.name}`),
          })),
          error: mcp?.error ?? null,
        };
      }),
    );
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/integrations/connections/{name}/prompts/get",
    tags,
    summary: "Render a prompt through spec-cli's catalog, as an agent would",
    request: {
      params: nameParam,
      ...json(
        z.object({
          prompt: z.string().min(1).max(300),
          arguments: StringMap.optional().default({}),
        }),
      ),
    },
    responses: ok("Rendered prompt", PromptResultSchema),
  }),
  async (c) => {
    const { name } = c.req.valid("param");
    const { prompt, arguments: args } = c.req.valid("json");
    return c.json(
      (await withSpecs(503, (client) =>
        client.tools.getPrompt(formatPromptName(name, prompt), args),
      )) as z.infer<typeof PromptResultSchema>,
    );
  },
);

export { app as integrationsRouter };
