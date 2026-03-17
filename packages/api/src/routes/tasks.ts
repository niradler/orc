import type { Database } from "bun:sqlite";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { TaskPrioritySchema, TaskStatusSchema } from "@orc/core/types";
import { getDb } from "@orc/db/client";
import { task_links, task_notes, tasks } from "@orc/db/schema";
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
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("Task");

const NoteSchema = z
  .object({
    id: z.string(),
    task_id: z.string(),
    content: z.string(),
    author: z.string(),
    created_at: z.string().datetime(),
  })
  .openapi("TaskNote");

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

const reviewRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/review",
  tags: ["Tasks"],
  summary: "Submit task for human review (HITL checkpoint)",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ summary: z.string().min(1) }).openapi("SubmitReview"),
        },
      },
    },
  },
  responses: {
    200: { description: "Submitted", content: { "application/json": { schema: TaskSchema } } },
  },
});

const checkReviewRoute = createRoute({
  method: "get",
  path: "/tasks/{id}/review",
  tags: ["Tasks"],
  summary: "Poll HITL review result",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Review status",
      content: {
        "application/json": {
          schema: z
            .object({
              status: z.enum(["review", "approved", "changes_requested", "pending"]),
              note: z.string().nullable(),
            })
            .openapi("ReviewStatus"),
        },
      },
    },
  },
});

const listNotesRoute = createRoute({
  method: "get",
  path: "/tasks/{id}/notes",
  tags: ["Tasks"],
  summary: "List task notes",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Notes",
      content: { "application/json": { schema: z.object({ notes: z.array(NoteSchema) }) } },
    },
  },
});

const addNoteRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/notes",
  tags: ["Tasks"],
  summary: "Add a note to a task",
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
            .openapi("AddNote"),
        },
      },
    },
  },
  responses: {
    201: { description: "Note added", content: { "application/json": { schema: NoteSchema } } },
  },
});

function toDto(t: typeof tasks.$inferSelect) {
  return {
    ...t,
    due_at: t.due_at?.toISOString() ?? null,
    created_at: t.created_at.toISOString(),
    updated_at: t.updated_at.toISOString(),
  };
}

function noteToDto(n: typeof task_notes.$inferSelect) {
  return {
    ...n,
    created_at: n.created_at.toISOString(),
  };
}

app.openapi(listRoute, async (c) => {
  const db = getDb();
  const { project_id, status, limit } = c.req.valid("query");

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

  if (body.status === "doing" && existing.status !== "doing") {
    const blockers = checkBlockers(getSqlite(), id);
    if (blockers.length > 0) {
      const names = blockers.map((b) => `[${b.id.slice(-6)}] ${b.title}`).join(", ");
      throw new ValidationError(`Cannot start: blocked by ${names}`);
    }
  }

  await db
    .update(tasks)
    .set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.due_at !== undefined ? { due_at: new Date(body.due_at) } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      updated_at: new Date(),
    })
    .where(eq(tasks.id, id));

  if (body.status && ["done", "cancelled"].includes(body.status)) {
    const sqlite = getSqlite();
    unblockDependents(sqlite, id);
    rollupParentProgress(sqlite, id);
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

app.openapi(reviewRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const { summary } = c.req.valid("json");

  const existing = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!existing) throw new NotFoundError("Task", id);
  if (!["doing", "blocked"].includes(existing.status)) {
    throw new ValidationError(
      `Task must be in doing/blocked to submit for review (current: ${existing.status})`,
    );
  }

  const now = new Date();

  await db
    .update(tasks)
    .set({ status: "review", body: summary, updated_at: now })
    .where(eq(tasks.id, id));

  await db.insert(task_notes).values({
    id: ulid(),
    task_id: id,
    content: `[review submitted] ${summary}`,
    author: "agent",
    created_at: now,
  });

  const updated = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!updated) throw new Error("Expected updated to exist after write");
  return c.json(toDto(updated));
});

app.openapi(checkReviewRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!task) throw new NotFoundError("Task", id);

  const lastNote = await db.query.task_notes.findFirst({
    where: and(eq(task_notes.task_id, id), eq(task_notes.author, "human")),
    orderBy: [desc(task_notes.created_at)],
  });

  type ReviewStatus = "review" | "approved" | "changes_requested" | "pending";
  const statusMap: Record<string, ReviewStatus> = {
    review: "review",
    done: "approved",
    changes_requested: "changes_requested",
  };
  const status: ReviewStatus = statusMap[task.status] ?? "pending";

  return c.json({ status, note: lastNote?.content ?? null });
});

app.openapi(listNotesRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!task) throw new NotFoundError("Task", id);

  const notes = await db.query.task_notes.findMany({
    where: eq(task_notes.task_id, id),
    orderBy: [desc(task_notes.created_at)],
  });

  return c.json({ notes: notes.map(noteToDto) });
});

app.openapi(addNoteRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const { content, author } = c.req.valid("json");

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!task) throw new NotFoundError("Task", id);

  const noteId = ulid();
  const now = new Date();
  await db.insert(task_notes).values({ id: noteId, task_id: id, content, author, created_at: now });

  const note = await db.query.task_notes.findFirst({ where: eq(task_notes.id, noteId) });
  if (!note) throw new Error("Expected note to exist after write");
  return c.json(noteToDto(note), 201);
});

app.openapi(batchCreateRoute, async (c) => {
  const db = getDb();
  const { tasks: items, project_id, author } = c.req.valid("json");
  const now = new Date();
  const mapping: Record<string, string> = {};

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

  return c.json({ created: items.length, mapping }, 201);
});

export { app as tasksRouter };
