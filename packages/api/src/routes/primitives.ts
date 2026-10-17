import { createRoute, z } from "@hono/zod-openapi";
import {
  createAgent,
  deleteAgent,
  discoverAgents,
  readAgent,
  updateAgent,
} from "@orc/core/agent-service";
import { NotFoundError } from "@orc/core/errors";
import {
  acquireApmSource,
  discoverRepositoryPackages,
  exportPackageArtifact,
  importAcquiredPackage,
  importRepositoryPackage,
  writePackageCommand,
} from "@orc/core/package-catalog";
import {
  AgentSetupSchema,
  buildPackagePlan,
  listAgentSetups,
  packagePlanArgv,
  packageToolCommands,
  saveAgentSetup,
} from "@orc/core/package-launch";
import {
  createPackage,
  listPackages,
  packageRevision,
  packageSkillFiles,
  readPackage,
  readPackageFile,
  updatePackage,
} from "@orc/core/package-service";
import { createRouter } from "../lib/router.js";

const app = createRouter();
app.openapi(
  createRoute({
    method: "get",
    path: "/package-tools",
    tags: ["Agent packages"],
    responses: {
      200: {
        description: "Upstream tooling availability",
        content: {
          "application/json": {
            schema: z.object({
              apm: z.boolean(),
              skills: z.boolean(),
              bun: z.boolean(),
            }),
          },
        },
      },
    },
  }),
  (c) => {
    const tools = packageToolCommands();
    return c.json({
      apm: tools.apm !== null,
      skills: tools.skills !== null,
      bun: tools.bun !== null,
    });
  },
);
app.openapi(
  createRoute({
    method: "get",
    path: "/agent-setups",
    tags: ["Agent packages"],
    responses: {
      200: {
        description: "Reusable agent setups",
        content: {
          "application/json": {
            schema: z.object({
              setups: z.array(AgentSetupSchema),
              broken: z.array(z.object({ path: z.string(), error: z.string() })),
            }),
          },
        },
      },
    },
  }),
  (c) => c.json(listAgentSetups()),
);
app.openapi(
  createRoute({
    method: "post",
    path: "/agent-setups",
    tags: ["Agent packages"],
    request: {
      body: { content: { "application/json": { schema: AgentSetupSchema } } },
    },
    responses: {
      201: {
        description: "Saved setup",
        content: { "application/json": { schema: AgentSetupSchema } },
      },
      409: { description: "Setup already exists" },
    },
  }),
  (c) => {
    return c.json(saveAgentSetup(c.req.valid("json")), 201);
  },
);
const BrokenSchema = z.object({ path: z.string(), error: z.string() });
const AgentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    source: z.enum(["user", "project", "package"]),
    path: z.string(),
    fields: z.record(z.string(), z.unknown()),
  })
  .openapi("AgentProfile");
const AgentFullSchema = AgentSchema.extend({
  content: z.string(),
  raw: z.string(),
}).openapi("AgentFull");
const PackageSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string(),
    path: z.string(),
    manifest: z.record(z.string(), z.unknown()),
    format: z.enum(["apm", "agent-plugin"]),
    manifestFile: z.enum(["apm.yml", "plugin.json"]),
    warnings: z.array(z.string()),
  })
  .openapi("ApmPackage");
const FileSchema = z.object({ name: z.string(), path: z.string() });
const PackageFullSchema = PackageSchema.extend({
  content: z.string(),
  files: z.array(FileSchema),
  revision: z.string().optional(),
}).openapi("ApmPackageFull");
const FileContentSchema = FileSchema.extend({
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]),
});
const FileInputSchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string().max(12 * 1024 * 1024),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

app.openapi(
  createRoute({
    method: "put",
    path: "/agents/{id}",
    tags: ["Agents"],
    summary: "Update an agent definition with optimistic concurrency checks",
    request: {
      params: z.object({ id: z.string().min(1).max(1024) }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              content: z
                .string()
                .min(1)
                .max(8 * 1024 * 1024),
              expectedRaw: z.string().max(8 * 1024 * 1024),
              expectedPath: z.string().min(1).max(4096),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated agent",
        content: { "application/json": { schema: AgentFullSchema } },
      },
      400: { description: "Invalid definition or path" },
      404: { description: "Agent not found" },
      409: { description: "Agent changed since it was opened" },
    },
  }),
  (c) => c.json(updateAgent(c.req.valid("param").id, c.req.valid("json"))),
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/agents/{id}",
    tags: ["Agents"],
    summary: "Delete the selected agent definition without deleting package resources",
    request: { params: z.object({ id: z.string().min(1).max(1024) }) },
    responses: {
      204: { description: "Agent deleted" },
      400: { description: "Invalid agent path" },
      404: { description: "Agent not found" },
    },
  }),
  (c) => {
    deleteAgent(c.req.valid("param").id);
    return c.body(null, 204);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/agents",
    tags: ["Agents"],
    summary: "Discover shared APM agent profiles",
    responses: {
      200: {
        description: "Agent profiles and validation errors",
        content: {
          "application/json": {
            schema: z.object({
              agents: z.array(AgentSchema),
              broken: z.array(BrokenSchema),
            }),
          },
        },
      },
    },
  }),
  (c) => c.json(discoverAgents()),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/agents/{id}",
    tags: ["Agents"],
    summary: "Read an APM agent profile",
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: "Agent definition",
        content: { "application/json": { schema: AgentFullSchema } },
      },
      404: { description: "Agent not found" },
    },
  }),
  (c) => {
    const { id } = c.req.valid("param");
    const agent = readAgent(id);
    if (!agent) throw new NotFoundError("Agent", id);
    return c.json(agent);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/agents",
    tags: ["Agents"],
    summary: "Create a shared .agent.md definition",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              id: z.string().min(1).max(200),
              content: z
                .string()
                .min(1)
                .max(8 * 1024 * 1024),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Agent created",
        content: { "application/json": { schema: AgentFullSchema } },
      },
      400: { description: "Invalid agent definition" },
      409: { description: "Agent already exists" },
    },
  }),
  (c) => {
    const { id, content } = c.req.valid("json");
    return c.json(createAgent(id, content), 201);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/agent-packages",
    tags: ["Agent packages"],
    summary: "List shared APM packages",
    responses: {
      200: {
        description: "Installed packages",
        content: {
          "application/json": {
            schema: z.object({
              packages: z.array(PackageSchema),
              broken: z.array(BrokenSchema),
            }),
          },
        },
      },
    },
  }),
  (c) => c.json(listPackages()),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/agent-packages/{name}",
    tags: ["Agent packages"],
    summary: "Read an APM package or bundled file",
    request: {
      params: z.object({ name: z.string() }),
      query: z.object({ ref: z.string().optional() }),
    },
    responses: {
      200: {
        description: "Package manifest or file",
        content: {
          "application/json": {
            schema: z.union([PackageFullSchema, FileContentSchema]),
          },
        },
      },
      400: { description: "Invalid file path" },
      404: { description: "Package or file not found" },
    },
  }),
  (c) => {
    const { name } = c.req.valid("param");
    const { ref } = c.req.valid("query");
    if (ref) return c.json(readPackageFile(name, ref));
    const pkg = readPackage(name);
    if (!pkg) throw new NotFoundError("Package", name);
    return c.json({ ...pkg, revision: packageRevision(pkg) });
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/agent-packages",
    tags: ["Agent packages"],
    summary: "Import a complete APM package without executing lifecycle scripts",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              name: z.string().min(1).max(200),
              content: z.string().min(1),
              files: z.array(FileInputSchema).max(512),
              format: z.enum(["apm", "agent-plugin"]).optional(),
              skills: z.array(z.string().min(1).max(200)).max(32).optional(),
              imported: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Package imported",
        content: { "application/json": { schema: PackageFullSchema } },
      },
      400: { description: "Invalid manifest or primitive" },
      409: { description: "Package already exists" },
    },
  }),
  (c) => {
    const { name, content, files, format, skills, imported } = c.req.valid("json");
    return c.json(
      createPackage(
        name,
        content,
        [...files, ...packageSkillFiles(skills ?? [], format ?? "apm")],
        format,
        imported,
      ),
      201,
    );
  },
);

app.openapi(
  createRoute({
    method: "put",
    path: "/agent-packages/{name}",
    tags: ["Agent packages"],
    request: {
      params: z.object({ name: z.string().min(1).max(200) }),
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                content: z
                  .string()
                  .min(1)
                  .max(8 * 1024 * 1024),
                files: z.array(FileInputSchema).max(512),
                expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
                skills: z.array(z.string().min(1).max(200)).max(32).optional(),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated package",
        content: { "application/json": { schema: PackageFullSchema } },
      },
      409: { description: "Package changed" },
    },
  }),
  (c) => {
    const pkg = updatePackage(c.req.valid("param").name, c.req.valid("json"));
    return c.json({ ...pkg, revision: packageRevision(pkg) });
  },
);

const DiscoverySchema = z.object({
  source: z.string(),
  repository: z.string(),
  commit: z.string(),
  packages: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      path: z.string(),
      format: z.enum(["apm", "agent-plugin"]),
      installed: z.boolean(),
    }),
  ),
  issues: z.array(BrokenSchema),
});
app.openapi(
  createRoute({
    method: "post",
    path: "/agent-packages/acquire",
    tags: ["Agent packages"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ source: z.string().min(1).max(2048) }).strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "APM acquired source for catalog inspection",
        content: {
          "application/json": {
            schema: z.object({
              token: z.string(),
              source: z.string(),
              packages: DiscoverySchema.shape.packages,
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    return c.json(await acquireApmSource(c.req.valid("json").source));
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/agent-packages/import-acquired",
    tags: ["Agent packages"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({ token: z.string().uuid(), path: z.string().min(1).max(1024) })
              .strict(),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Acquired source added to the catalog",
        content: { "application/json": { schema: PackageFullSchema } },
      },
    },
  }),
  (c) => {
    const input = c.req.valid("json");
    return c.json(importAcquiredPackage(input.token, input.path), 201);
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/agent-packages/discover",
    tags: ["Agent packages"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ source: z.string().min(1).max(2048) }).strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Packages at an immutable Git commit",
        content: { "application/json": { schema: DiscoverySchema } },
      },
    },
  }),
  async (c) => {
    return c.json(await discoverRepositoryPackages(c.req.valid("json").source));
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/agent-packages/import-git",
    tags: ["Agent packages"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                source: z.string().min(1).max(2048),
                commit: z.string().regex(/^[a-f0-9]{40}$/),
                path: z.string().max(1024),
                format: z.enum(["apm", "agent-plugin"]),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      201: {
        description: "APM acquired package saved in the catalog",
        content: { "application/json": { schema: PackageFullSchema } },
      },
    },
  }),
  async (c) => {
    return c.json(await importRepositoryPackage(c.req.valid("json")), 201);
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/agent-packages/{name}/export",
    tags: ["Agent packages"],
    request: { params: z.object({ name: z.string().min(1).max(200) }) },
    responses: {
      200: {
        description: "APM built installation artifact",
        content: {
          "application/json": {
            schema: z.object({ filename: z.string(), content: z.string(), format: z.string() }),
          },
        },
      },
    },
  }),
  async (c) => {
    return c.json(await exportPackageArtifact(c.req.valid("param").name));
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/agent-setups/command",
    tags: ["Agent packages"],
    request: { body: { content: { "application/json": { schema: AgentSetupSchema } } } },
    responses: {
      200: {
        description: "Command to execute this plan on the API machine",
        content: {
          "application/json": {
            schema: z.object({ command: z.string(), shell: z.string(), notice: z.string() }),
          },
        },
      },
    },
  }),
  (c) => {
    const tools = packageToolCommands();
    if (!tools.bun) throw new NotFoundError("Executable", "bun");
    const plan = buildPackagePlan(c.req.valid("json"), tools);
    return c.json({
      command: writePackageCommand(packagePlanArgv(plan, tools.bun)),
      shell: process.platform === "win32" ? "PowerShell" : "sh",
      notice: plan.notice,
    });
  },
);

export const primitivesRouter = app;
