import type { Database } from "bun:sqlite";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { NotFoundError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { getDb } from "@orc/db/client";
import { projects } from "@orc/db/schema";
import { and, eq } from "drizzle-orm";

const app = new OpenAPIHono();

const ProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.enum(["active", "archived", "paused"]),
    scope: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    obsidian_path: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("Project");

const CreateProjectSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .min(1)
      .max(100),
    description: z.string().optional(),
    status: z.enum(["active", "archived", "paused"]).optional().default("active"),
    scope: z.string().optional(),
    tags: z.array(z.string()).optional(),
    obsidian_path: z.string().optional(),
  })
  .openapi("CreateProject");

const UpdateProjectSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .min(1)
      .max(100)
      .optional(),
    description: z.string().optional(),
    status: z.enum(["active", "archived", "paused"]).optional(),
    scope: z.string().optional(),
    tags: z.array(z.string()).optional(),
    obsidian_path: z.string().optional(),
  })
  .openapi("UpdateProject");

const listRoute = createRoute({
  method: "get",
  path: "/projects",
  tags: ["Projects"],
  summary: "List projects",
  request: {
    query: z.object({
      status: z.enum(["active", "archived", "paused"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    }),
  },
  responses: {
    200: {
      description: "Projects",
      content: { "application/json": { schema: z.object({ projects: z.array(ProjectSchema) }) } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/projects/{id}",
  tags: ["Projects"],
  summary: "Get project by ID",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Project", content: { "application/json": { schema: ProjectSchema } } },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/projects",
  tags: ["Projects"],
  summary: "Create project",
  request: { body: { content: { "application/json": { schema: CreateProjectSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: ProjectSchema } } },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/projects/{id}",
  tags: ["Projects"],
  summary: "Update project",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: UpdateProjectSchema } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: ProjectSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/projects/{id}",
  tags: ["Projects"],
  summary: "Delete project",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: "Deleted" },
  },
});

const getByNameRoute = createRoute({
  method: "get",
  path: "/projects/by-name/{name}",
  tags: ["Projects"],
  summary: "Get project by name (case-insensitive)",
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "Project", content: { "application/json": { schema: ProjectSchema } } },
  },
});

const summaryRoute = createRoute({
  method: "get",
  path: "/projects/{id}/summary",
  tags: ["Projects"],
  summary: "Get project summary with task/memory/job counts",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Project summary",
      content: {
        "application/json": {
          schema: z.object({
            project: ProjectSchema,
            tasks: z.object({
              total: z.number(),
              by_status: z.record(z.number()),
            }),
            memories: z.number(),
            jobs: z.number(),
          }),
        },
      },
    },
  },
});

function toDto(p: typeof projects.$inferSelect) {
  return {
    ...p,
    created_at: p.created_at.toISOString(),
    updated_at: p.updated_at.toISOString(),
  };
}

app.openapi(listRoute, async (c) => {
  const db = getDb();
  const { status, limit } = c.req.valid("query");
  const conditions = status ? [eq(projects.status, status)] : [];
  const rows = await db.query.projects.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    limit,
    orderBy: (p, { asc }) => [asc(p.name)],
  });
  return c.json({ projects: rows.map(toDto) });
});

app.openapi(getByNameRoute, async (c) => {
  const db = getDb();
  const { name } = c.req.valid("param");
  const sqlite = (db as unknown as { $client: Database }).$client;
  const row = sqlite
    .query<typeof projects.$inferSelect, string>(
      "SELECT * FROM projects WHERE name = ? COLLATE NOCASE LIMIT 1",
    )
    .get(name);
  if (!row) throw new NotFoundError("Project", name);
  return c.json(toDto(row));
});

app.openapi(summaryRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const project = await db.query.projects.findFirst({ where: eq(projects.id, id) });
  if (!project) throw new NotFoundError("Project", id);

  const sqlite = (db as unknown as { $client: Database }).$client;

  const taskRows = sqlite
    .query<{ status: string; count: number }, string>(
      "SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY status",
    )
    .all(id);
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of taskRows) {
    byStatus[row.status] = row.count;
    total += row.count;
  }

  const memCount =
    sqlite
      .query<{ count: number }, string>(
        "SELECT COUNT(*) as count FROM memories WHERE project_id = ?",
      )
      .get(id)?.count ?? 0;

  const jobCount =
    sqlite
      .query<{ count: number }, string>("SELECT COUNT(*) as count FROM jobs WHERE project_id = ?")
      .get(id)?.count ?? 0;

  return c.json({
    project: toDto(project),
    tasks: { total, by_status: byStatus },
    memories: memCount,
    jobs: jobCount,
  });
});

app.openapi(getRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const project = await db.query.projects.findFirst({ where: eq(projects.id, id) });
  if (!project) throw new NotFoundError("Project", id);
  return c.json(toDto(project));
});

app.openapi(createRoute_, async (c) => {
  const db = getDb();
  const body = c.req.valid("json");
  const now = new Date();
  const id = ulid();

  await db.insert(projects).values({
    id,
    name: body.name,
    description: body.description,
    status: body.status,
    scope: body.scope,
    tags: body.tags,
    obsidian_path: body.obsidian_path,
    created_at: now,
    updated_at: now,
  });

  const project = await db.query.projects.findFirst({ where: eq(projects.id, id) });
  if (!project) throw new Error("Expected project to exist after write");
  return c.json(toDto(project), 201);
});

app.openapi(updateRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const existing = await db.query.projects.findFirst({ where: eq(projects.id, id) });
  if (!existing) throw new NotFoundError("Project", id);

  await db
    .update(projects)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.obsidian_path !== undefined ? { obsidian_path: body.obsidian_path } : {}),
      updated_at: new Date(),
    })
    .where(eq(projects.id, id));

  const updated = await db.query.projects.findFirst({ where: eq(projects.id, id) });
  if (!updated) throw new Error("Expected updated to exist after write");
  return c.json(toDto(updated));
});

app.openapi(deleteRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const existing = await db.query.projects.findFirst({ where: eq(projects.id, id) });
  if (!existing) throw new NotFoundError("Project", id);
  await db.delete(projects).where(eq(projects.id, id));
  return new Response(null, { status: 204 });
});

export { app as projectsRouter };
