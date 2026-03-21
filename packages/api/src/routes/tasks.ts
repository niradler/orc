import type { Database } from "bun:sqlite";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import type { TaskStatus } from "@orc/core/types";
import { TaskPrioritySchema, TaskStatusSchema } from "@orc/core/types";
import { getDb } from "@orc/db/client";
import { comments, task_links, tasks } from "@orc/db/schema";
import { addTaskComment, updateTaskStatus } from "@orc/task-service";
import { and, desc, eq } from "drizzle-orm";
import { checkBlockers, rollupParentProgress, unblockDependents } from "../lib/task-deps.js";

function getSqlite(): Database {
  const db = getDb();
  return (db as unknown as { $client: Database }).$client;
}

const app = new OpenAPIHono();

const TaskSchema = z
  .object({
    id: z.string(),
    project_id: z.string().nullable(),
    title: z.string(),
    body: z.string().nullable(),
    status: TaskStatusSchema,
    priority: TaskPrioritySchema,
    progress: z.number().int(),
    due_at: z.string().datetime().nullable(),
    tags: z.array(z.string()).nullable(),
    author: z.string(),
    claimed_by: z.string().nullable(),
    claim_expires_at: z.string().datetime().nullable(),
    prompt_id: z.string().nullable(),
    required_review: z.boolean(),
    agent_backend: z.string().nullable(),
    max_review_rounds: z.number().int(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("Task");

const CommentSchema = z
  .object({
    id: z.string(),
    resource_type: z.string(),
    resource_id: z.string(),
    content: z.string(),
    author: z.string(),
    created_at: z.string().datetime(),
  })
  .openapi("Comment");

const CreateTaskSchema = z
  .object({
    title: z.string().min(1).max(500),
    body: z.string().optional(),
    project_id: z.string().optional(),
    status: z.enum(["todo", "doing", "blocked"]).optional().default("todo"),
    priority: TaskPrioritySchema.optional().default("normal"),
    due_at: z.string().datetime().optional(),
    tags: z.array(z.string()).optional(),
    author: z.string().optional().default("human"),
    prompt_id: z.string().optional(),
    required_review: z.boolean().optional().default(true),
    agent_backend: z.enum(["claude", "codex", "cursor"]).optional(),
    max_review_rounds: z.number().int().min(1).optional().default(3),
  })
  .openapi("CreateTask");

const UpdateTaskSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    body: z.string().optional(),
    status: TaskStatusSchema.optional(),
    priority: TaskPrioritySchema.optional(),
    due_at: z.string().datetime().optional(),
    tags: z.array(z.string()).optional(),
    comment: z.string().optional(),
  })
  .openapi("UpdateTask");

const listRoute = createRoute({
  method: "get",
  path: "/tasks",
  tags: ["Tasks"],
  summary: "List tasks",
  request: {
    query: z.object({
      project_id: z.string().optional(),
      status: TaskStatusSchema.optional(),
      tag: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    }),
  },
  responses: {
    200: {
      description: "Task list",
      content: {
        "application/json": { schema: z.object({ tasks: z.array(TaskSchema), total: z.number() }) },
      },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/tasks/{id}",
  tags: ["Tasks"],
  summary: "Get task by ID",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Task", content: { "application/json": { schema: TaskSchema } } },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/tasks",
  tags: ["Tasks"],
  summary: "Create task",
  request: { body: { content: { "application/json": { schema: CreateTaskSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: TaskSchema } } },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/tasks/{id}",
  tags: ["Tasks"],
  summary: "Update task",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: UpdateTaskSchema } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: TaskSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/tasks/{id}",
  tags: ["Tasks"],
  summary: "Delete task",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: "Deleted" },
  },
});

const BatchTaskItem = z.object({
  ref: z.string().describe("Temporary reference ID for dependency linking, e.g. 'T1'"),
  title: z.string().min(1).max(500),
  body: z.string().optional(),
  priority: TaskPrioritySchema.optional().default("normal"),
  depends_on: z.array(z.string()).optional().describe("Refs of tasks that block this one"),
  subtask_of: z.string().optional().describe("Ref of parent task"),
});

const batchCreateRoute = createRoute({
  method: "post",
  path: "/tasks/batch",
  tags: ["Tasks"],
  summary: "Create multiple tasks with dependency links atomically",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              tasks: z.array(BatchTaskItem).min(1).max(100),
              project_id: z.string().optional(),
              author: z.string().optional().default("agent"),
            })
            .openapi("BatchCreateTasks"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created tasks with ref→id mapping",
      content: {
        "application/json": {
          schema: z.object({
            created: z.number(),
            mapping: z.record(z.string(), z.string()),
          }),
        },
      },
    },
  },
});

const listCommentsRoute = createRoute({
  method: "get",
  path: "/tasks/{id}/comments",
  tags: ["Tasks"],
  summary: "List task comments",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Comments",
      content: { "application/json": { schema: z.object({ comments: z.array(CommentSchema) }) } },
    },
  },
});

const addCommentRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/comments",
  tags: ["Tasks"],
  summary: "Add a comment to a task",
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
            .openapi("AddComment"),
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

function toDto(t: typeof tasks.$inferSelect) {
  return {
    ...t,
    due_at: t.due_at?.toISOString() ?? null,
    claim_expires_at: t.claim_expires_at?.toISOString() ?? null,
    prompt_id: t.prompt_id ?? null,
    required_review: t.required_review,
    agent_backend: t.agent_backend ?? null,
    max_review_rounds: t.max_review_rounds,
    created_at: t.created_at.toISOString(),
    updated_at: t.updated_at.toISOString(),
  };
}

function rawToDto(row: Record<string, unknown>) {
  return {
    ...row,
    tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags,
    due_at: row.due_at ? new Date((row.due_at as number) * 1000).toISOString() : null,
    claim_expires_at: row.claim_expires_at
      ? new Date((row.claim_expires_at as number) * 1000).toISOString()
      : null,
    created_at: new Date((row.created_at as number) * 1000).toISOString(),
    updated_at: new Date((row.updated_at as number) * 1000).toISOString(),
  };
}

function commentToDto(n: typeof comments.$inferSelect) {
  return {
    ...n,
    created_at: n.created_at.toISOString(),
  };
}

app.openapi(listRoute, async (c) => {
  const db = getDb();
  const { project_id, status, tag, limit } = c.req.valid("query");

  if (tag) {
    const sqlite = getSqlite();
    let sql = `SELECT DISTINCT t.* FROM tasks t, json_each(t.tags) AS j WHERE j.value = ?`;
    const params: (string | number)[] = [tag];
    if (project_id) {
      sql += " AND t.project_id = ?";
      params.push(project_id);
    }
    if (status) {
      sql += " AND t.status = ?";
      params.push(status);
    }
    sql += " ORDER BY t.updated_at DESC LIMIT ?";
    params.push(limit);
    const rows = sqlite.query(sql).all(...params) as Record<string, unknown>[];
    const mapped = rows.map(rawToDto) as ReturnType<typeof toDto>[];
    return c.json({ tasks: mapped, total: rows.length });
  }

  const conditions = [];
  if (project_id) conditions.push(eq(tasks.project_id, project_id));
  if (status) conditions.push(eq(tasks.status, status));

  const rows = await db.query.tasks.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    limit,
    orderBy: [desc(tasks.updated_at)],
  });

  return c.json({ tasks: rows.map(toDto), total: rows.length });
});

app.openapi(getRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!task) throw new NotFoundError("Task", id);
  return c.json(toDto(task));
});

app.openapi(createRoute_, async (c) => {
  const db = getDb();
  const body = c.req.valid("json");
  const now = new Date();
  const id = ulid();

  await db.insert(tasks).values({
    id,
    title: body.title,
    body: body.body,
    project_id: body.project_id,
    status: body.status,
    priority: body.priority,
    ...(body.due_at ? { due_at: new Date(body.due_at) } : {}),
    tags: body.tags,
    author: body.author,
    prompt_id: body.prompt_id,
    required_review: body.required_review ?? true,
    agent_backend: body.agent_backend as "claude" | "codex" | "cursor" | undefined,
    max_review_rounds: body.max_review_rounds ?? 3,
    created_at: now,
    updated_at: now,
  });

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!task) throw new Error("Expected task to exist after write");
  return c.json(toDto(task), 201);
});

app.openapi(updateRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const existing = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!existing) throw new NotFoundError("Task", id);

  const nonStatusFields = {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.body !== undefined ? { body: body.body } : {}),
    ...(body.priority !== undefined ? { priority: body.priority } : {}),
    ...(body.due_at !== undefined ? { due_at: new Date(body.due_at) } : {}),
    ...(body.tags !== undefined ? { tags: body.tags } : {}),
  };
  if (Object.keys(nonStatusFields).length > 0) {
    await db
      .update(tasks)
      .set({ ...nonStatusFields, updated_at: new Date() })
      .where(eq(tasks.id, id));
  }

  if (body.status) {
    const result = await updateTaskStatus({
      taskId: id,
      status: body.status as TaskStatus,
      comment: body.comment,
      author: "api",
    });
    if (!result.ok) throw new ValidationError(result.error ?? "Transition failed");
  } else if (body.comment) {
    await addTaskComment(id, body.comment, "api");
  }

  const updated = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!updated) throw new Error("Expected updated to exist after write");
  return c.json(toDto(updated));
});

app.openapi(deleteRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const existing = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!existing) throw new NotFoundError("Task", id);
  await db.delete(tasks).where(eq(tasks.id, id));
  return new Response(null, { status: 204 });
});

app.openapi(listCommentsRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!task) throw new NotFoundError("Task", id);

  const rows = await db.query.comments.findMany({
    where: and(eq(comments.resource_type, "task"), eq(comments.resource_id, id)),
    orderBy: [desc(comments.created_at)],
  });

  return c.json({ comments: rows.map(commentToDto) });
});

app.openapi(addCommentRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const { content, author } = c.req.valid("json");

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!task) throw new NotFoundError("Task", id);

  const commentId = ulid();
  const now = new Date();
  await db.insert(comments).values({
    id: commentId,
    resource_type: "task",
    resource_id: id,
    content,
    author,
    created_at: now,
  });

  const comment = await db.query.comments.findFirst({ where: eq(comments.id, commentId) });
  if (!comment) throw new Error("Expected comment to exist after write");
  return c.json(commentToDto(comment), 201);
});

app.openapi(batchCreateRoute, async (c) => {
  const db = getDb();
  const { tasks: items, project_id, author } = c.req.valid("json");
  const now = new Date();
  const mapping: Record<string, string> = {};

  const sqlite = getSqlite();
  sqlite.exec("BEGIN");
  try {
    for (const item of items) {
      const id = ulid();
      mapping[item.ref] = id;
      await db.insert(tasks).values({
        id,
        title: item.title,
        body: item.body,
        project_id,
        priority: item.priority,
        author,
        status: "todo",
        created_at: now,
        updated_at: now,
      });
    }

    for (const item of items) {
      const taskId = mapping[item.ref] as string;

      if (item.depends_on) {
        for (const dep of item.depends_on) {
          const blockerId = mapping[dep];
          if (!blockerId) continue;
          await db.insert(task_links).values({
            id: ulid(),
            from_task_id: blockerId,
            to_task_id: taskId,
            link_type: "blocks",
            created_at: now,
          });
        }
      }

      if (item.subtask_of) {
        const parentId = mapping[item.subtask_of];
        if (parentId) {
          await db.insert(task_links).values({
            id: ulid(),
            from_task_id: taskId,
            to_task_id: parentId,
            link_type: "subtask_of",
            created_at: now,
          });
          await db.insert(task_links).values({
            id: ulid(),
            from_task_id: parentId,
            to_task_id: taskId,
            link_type: "parent_of",
            created_at: now,
          });
        }
      }
    }
    sqlite.exec("COMMIT");
  } catch (err) {
    sqlite.exec("ROLLBACK");
    throw err;
  }

  return c.json({ created: items.length, mapping }, 201);
});

export { app as tasksRouter };
