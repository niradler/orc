import type { Database } from "bun:sqlite";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { NotFoundError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { getDb } from "@orc/db/client";
import {
  bridge_chats,
  comments,
  jobs,
  knowledge_collections,
  memories,
  projects,
  sessions,
  tasks,
} from "@orc/db/schema";
import { and, desc, eq } from "drizzle-orm";

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
    max_workers: z.number().int().nullable(),
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
    max_workers: z.number().int().min(1).optional(),
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
    description: z.string().nullable().optional(),
    status: z.enum(["active", "archived", "paused"]).optional(),
    scope: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    obsidian_path: z.string().optional(),
    max_workers: z.number().int().min(1).nullable().optional(),
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
      tag: z.string().optional(),
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
              by_status: z.record(z.string(), z.number()),
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
    max_workers: p.max_workers ?? null,
    created_at: p.created_at.toISOString(),
    updated_at: p.updated_at.toISOString(),
  };
}

function rawToDto(row: Record<string, unknown>) {
  return {
    ...row,
    tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags,
    created_at: new Date((row.created_at as number) * 1000).toISOString(),
    updated_at: new Date((row.updated_at as number) * 1000).toISOString(),
  };
}

app.openapi(listRoute, async (c) => {
  const db = getDb();
  const { status, tag, limit } = c.req.valid("query");

  if (tag) {
    const sqlite = (db as unknown as { $client: Database }).$client;
    let sql = `SELECT DISTINCT p.* FROM projects p, json_each(p.tags) AS j WHERE j.value = ?`;
    const params: (string | number)[] = [tag];
    if (status) {
      sql += " AND p.status = ?";
      params.push(status);
    }
    sql += " ORDER BY p.name ASC LIMIT ?";
    params.push(limit);
    const rows = sqlite.query(sql).all(...params) as Record<string, unknown>[];
    const mapped = rows.map(rawToDto) as ReturnType<typeof toDto>[];
    return c.json({ projects: mapped });
  }

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
  return c.json(rawToDto(row as unknown as Record<string, unknown>) as ReturnType<typeof toDto>);
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
    max_workers: body.max_workers,
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
      ...(body.max_workers !== undefined ? { max_workers: body.max_workers } : {}),
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
  await db.transaction(async (tx) => {
    await tx.update(tasks).set({ project_id: null }).where(eq(tasks.project_id, id));
    await tx.update(memories).set({ project_id: null }).where(eq(memories.project_id, id));
    await tx.update(jobs).set({ project_id: null }).where(eq(jobs.project_id, id));
    await tx.update(sessions).set({ project_id: null }).where(eq(sessions.project_id, id));
    await tx.update(bridge_chats).set({ project_id: null }).where(eq(bridge_chats.project_id, id));
    await tx
      .update(knowledge_collections)
      .set({ project_id: null })
      .where(eq(knowledge_collections.project_id, id));
    await tx.delete(projects).where(eq(projects.id, id));
  });
  return new Response(null, { status: 204 });
});

// --- Project Comments ---

const CommentSchema = z
  .object({
    id: z.string(),
    resource_type: z.string(),
    resource_id: z.string(),
    content: z.string(),
    author: z.string(),
    created_at: z.string().datetime(),
  })
  .openapi("ProjectComment");

const listCommentsRoute = createRoute({
  method: "get",
  path: "/projects/{id}/comments",
  tags: ["Projects"],
  summary: "List project comments",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Comments",
      content: {
        "application/json": {
          schema: z.object({ comments: z.array(CommentSchema) }),
        },
      },
    },
  },
});

const addCommentRoute = createRoute({
  method: "post",
  path: "/projects/{id}/comments",
  tags: ["Projects"],
  summary: "Add a comment to a project",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              content: z.string().min(1),
              author: z.string().optional().default("human"),
            })
            .openapi("AddProjectComment"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Comment added",
      content: { "application/json": { schema: CommentSchema } },
    },
  },
});

function commentToDto(c: typeof comments.$inferSelect) {
  return { ...c, created_at: c.created_at.toISOString() };
}

app.openapi(listCommentsRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const project = await db.query.projects.findFirst({ where: eq(projects.id, id) });
  if (!project) throw new NotFoundError("Project", id);
  const rows = await db.query.comments.findMany({
    where: and(eq(comments.resource_type, "project"), eq(comments.resource_id, id)),
    orderBy: [desc(comments.created_at)],
  });
  return c.json({ comments: rows.map(commentToDto) });
});

app.openapi(addCommentRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const { content, author } = c.req.valid("json");
  const project = await db.query.projects.findFirst({ where: eq(projects.id, id) });
  if (!project) throw new NotFoundError("Project", id);
  const commentId = ulid();
  const now = new Date();
  await db.insert(comments).values({
    id: commentId,
    resource_type: "project",
    resource_id: id,
    content,
    author,
    created_at: now,
  });
  const row = await db.query.comments.findFirst({ where: eq(comments.id, commentId) });
  if (!row) throw new Error("Expected comment to exist after write");
  return c.json(commentToDto(row), 201);
});

export { app as projectsRouter };
