import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getSqlite } from "@orc/db/client";
import { MEMORY_DESCRIPTION_MAX, MEMORY_PRIORITY_MAX, MemoryStore } from "@orc/db/memories";
import { readSourceFromClient } from "@orc/db/read-usage";

const app = new OpenAPIHono();
const ORC_CLIENT_HEADER = "X-Orc-Client";
const API_AUTHOR = "api";

const PrioritySchema = z
  .number()
  .int()
  .min(0)
  .max(MEMORY_PRIORITY_MAX)
  .nullable()
  .openapi({ description: "0-100, higher loads first in context; null = not scored" });
const ReadsBySourceSchema = z.object({
  mcp: z.number().int(),
  cli: z.number().int(),
  api: z.number().int(),
  ui: z.number().int(),
});
const MemorySchema = z
  .object({
    project_id: z.string(),
    name: z.string(),
    description: z.string(),
    content: z.string(),
    priority: z.number().int().nullable(),
    author: z.string(),
    session_id: z.string().nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .openapi("Memory");
const MemoryListItemSchema = MemorySchema.omit({ content: true })
  .extend({
    key: z.string(),
    read_count: z.number().int(),
    reads_by_source: ReadsBySourceSchema,
    last_read_at: z.number().int().nullable(),
    activity_at: z.number().int(),
  })
  .openapi("MemoryListItem");
const SnapshotSchema = z.object({
  description: z.string(),
  content: z.string(),
  priority: z.number().int().nullable(),
});
const MemoryChangeSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    memory_name: z.string(),
    action: z.enum(["memory.created", "memory.updated", "memory.deleted", "memory.reverted"]),
    previous: SnapshotSchema.nullable(),
    current: SnapshotSchema.nullable(),
    reason: z.string().nullable(),
    author: z.string(),
    session_id: z.string().nullable(),
    created_at: z.number().int(),
  })
  .openapi("MemoryChange");

const NameParam = z.object({ name: z.string().min(1).max(64) });
const ProjectQuery = z.object({ project_id: z.string().min(1) });
const Writer = {
  author: z.string().min(1).max(200).optional(),
  session_id: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .openapi({ description: "Native session id of the agent making the change, when known" }),
};
const CreateMemorySchema = z
  .object({
    project_id: z.string().min(1),
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(MEMORY_DESCRIPTION_MAX),
    content: z.string().min(1),
    priority: PrioritySchema.optional(),
    ...Writer,
  })
  .strict()
  .openapi("CreateMemory");
const UpdateMemorySchema = z
  .object({
    project_id: z.string().min(1),
    description: z.string().min(1).max(MEMORY_DESCRIPTION_MAX).optional(),
    content: z.string().min(1).optional(),
    priority: PrioritySchema.optional(),
    reason: z.string().max(2000).optional(),
    ...Writer,
  })
  .strict()
  .openapi("UpdateMemory");

const store = (): MemoryStore => new MemoryStore(getSqlite());

app.openapi(
  createRoute({
    method: "get",
    path: "/memories",
    tags: ["Memory"],
    summary: "List memories of a project (or all projects), most read first",
    request: {
      query: z.object({
        project_id: z.string().optional(),
        q: z.string().optional().openapi({ description: "Search name and description" }),
        sort: z.enum(["reads", "recent", "priority"]).optional().openapi({
          description:
            "reads (default): most read first; recent: last read or updated first; priority: highest priority first",
        }),
        limit: z.coerce.number().int().min(1).max(500).optional().default(30),
      }),
    },
    responses: {
      200: {
        description: "Memory list",
        content: {
          "application/json": {
            schema: z.object({ memories: z.array(MemoryListItemSchema), total: z.number().int() }),
          },
        },
      },
    },
  }),
  (c) => {
    const { project_id, q, sort, limit } = c.req.valid("query");
    const memories = store().list(project_id ?? null, { q, sort });
    return c.json({ memories: memories.slice(0, limit), total: memories.length });
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/memories/{name}",
    tags: ["Memory"],
    summary: "Read a memory; counts a read for the calling client",
    request: { params: NameParam, query: ProjectQuery },
    responses: {
      200: { description: "Memory", content: { "application/json": { schema: MemorySchema } } },
      404: { description: "Memory not found" },
    },
  }),
  (c) => {
    const source = readSourceFromClient(c.req.header(ORC_CLIENT_HEADER));
    return c.json(store().read(c.req.valid("query").project_id, c.req.valid("param").name, source));
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/memories",
    tags: ["Memory"],
    summary: "Create a memory (content over the limit belongs in a skill)",
    request: { body: { content: { "application/json": { schema: CreateMemorySchema } } } },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: MemorySchema } } },
      400: { description: "Validation error" },
      409: { description: "A memory with this name already exists in the project" },
    },
  }),
  (c) => {
    const input = c.req.valid("json");
    return c.json(store().create({ ...input, author: input.author ?? API_AUTHOR }), 201);
  },
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/memories/{name}",
    tags: ["Memory"],
    summary: "Update a memory's description, content or priority",
    request: {
      params: NameParam,
      body: { content: { "application/json": { schema: UpdateMemorySchema } } },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: MemorySchema } } },
      404: { description: "Memory not found" },
    },
  }),
  (c) => {
    const { project_id, author, session_id, reason, ...fields } = c.req.valid("json");
    return c.json(
      store().update(project_id, c.req.valid("param").name, fields, {
        author: author ?? API_AUTHOR,
        session_id,
        reason,
      }),
    );
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/memories/{name}",
    tags: ["Memory"],
    summary: "Delete a memory (revertible from its history)",
    request: {
      params: NameParam,
      query: ProjectQuery.extend(Writer),
    },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Memory not found" },
    },
  }),
  (c) => {
    const { project_id, author, session_id } = c.req.valid("query");
    store().remove(project_id, c.req.valid("param").name, {
      author: author ?? API_AUTHOR,
      session_id,
    });
    return c.body(null, 204);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/memories/{name}/history",
    tags: ["Memory"],
    summary: "Changes to a memory, newest first",
    request: { params: NameParam, query: ProjectQuery },
    responses: {
      200: {
        description: "Changes",
        content: {
          "application/json": { schema: z.object({ changes: z.array(MemoryChangeSchema) }) },
        },
      },
    },
  }),
  (c) =>
    c.json({
      changes: store().history(c.req.valid("query").project_id, c.req.valid("param").name),
    }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/memories/{name}/revert",
    tags: ["Memory"],
    summary: "Restore the state from before a change, guarded by the latest change id",
    request: {
      params: NameParam,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                project_id: z.string().min(1),
                change_id: z.string().min(1),
                expected_change_id: z.string().min(1),
                reason: z.string().trim().min(1).max(2000),
                ...Writer,
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The memory after the revert; null when the revert deleted it",
        content: { "application/json": { schema: z.object({ memory: MemorySchema.nullable() }) } },
      },
      409: { description: "Memory changed since review" },
    },
  }),
  (c) => {
    const input = c.req.valid("json");
    const memory = store().revert(
      input.project_id,
      c.req.valid("param").name,
      input.change_id,
      input.expected_change_id,
      { reason: input.reason, author: input.author ?? "human", session_id: input.session_id },
    );
    return c.json({ memory });
  },
);

export const memoriesRouter = app;
