import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  createAgent,
  deleteAgent,
  discoverAgents,
  readAgent,
  updateAgent,
} from "@orc/core/agent-service";
import { NotFoundError } from "@orc/core/errors";
import {
  createPackage,
  listPackages,
  readPackage,
  readPackageFile,
} from "@orc/core/package-service";

const app = new OpenAPIHono();
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
const AgentFullSchema = AgentSchema.extend({ content: z.string(), raw: z.string() }).openapi(
  "AgentFull",
);
const PackageSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string(),
    path: z.string(),
    manifest: z.record(z.string(), z.unknown()),
  })
  .openapi("ApmPackage");
const FileSchema = z.object({ name: z.string(), path: z.string() });
const PackageFullSchema = PackageSchema.extend({
  content: z.string(),
  files: z.array(FileSchema),
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
            schema: z.object({ agents: z.array(AgentSchema), broken: z.array(BrokenSchema) }),
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
            schema: z.object({ packages: z.array(PackageSchema), broken: z.array(BrokenSchema) }),
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
          "application/json": { schema: z.union([PackageFullSchema, FileContentSchema]) },
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
    return c.json(pkg);
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
    const { name, content, files } = c.req.valid("json");
    return c.json(createPackage(name, content, files), 201);
  },
);

export const primitivesRouter = app;
