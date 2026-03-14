import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { TaskLinkTypeSchema } from "@orc/core/types";
import { getDb } from "@orc/db/client";
import { task_links, tasks } from "@orc/db/schema";
import { and, eq, or } from "drizzle-orm";

const app = new OpenAPIHono();

const TaskLinkSchema = z
  .object({
    id: z.string(),
    from_task_id: z.string(),
    to_task_id: z.string(),
    link_type: TaskLinkTypeSchema,
    created_at: z.string().datetime(),
  })
  .openapi("TaskLink");

const CreateLinkSchema = z
  .object({
    to_task_id: z.string(),
    link_type: TaskLinkTypeSchema,
  })
  .openapi("CreateTaskLink");

const listLinksRoute = createRoute({
  method: "get",
  path: "/tasks/{id}/links",
  tags: ["Tasks"],
  summary: "List links for a task (both directions)",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Links",
      content: { "application/json": { schema: z.object({ links: z.array(TaskLinkSchema) }) } },
    },
  },
});

const createLinkRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/links",
  tags: ["Tasks"],
  summary: "Link this task to another task",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: CreateLinkSchema } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: TaskLinkSchema } } },
  },
});

const deleteLinkRoute = createRoute({
  method: "delete",
  path: "/tasks/{id}/links/{linkId}",
  tags: ["Tasks"],
  summary: "Remove a task link",
  request: { params: z.object({ id: z.string(), linkId: z.string() }) },
  responses: {
    204: { description: "Deleted" },
  },
});

function linkToDto(l: typeof task_links.$inferSelect) {
  return {
    ...l,
    created_at: l.created_at.toISOString(),
  };
}

app.openapi(listLinksRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!task) throw new NotFoundError("Task", id);

  const rows = await db.query.task_links.findMany({
    where: or(eq(task_links.from_task_id, id), eq(task_links.to_task_id, id)),
  });

  return c.json({ links: rows.map(linkToDto) });
});

app.openapi(createLinkRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const { to_task_id, link_type } = c.req.valid("json");

  const [fromTask, toTask] = await Promise.all([
    db.query.tasks.findFirst({ where: eq(tasks.id, id) }),
    db.query.tasks.findFirst({ where: eq(tasks.id, to_task_id) }),
  ]);
  if (!fromTask) throw new NotFoundError("Task", id);
  if (!toTask) throw new NotFoundError("Task", to_task_id);
  if (id === to_task_id) throw new ValidationError("Cannot link a task to itself");

  const existing = await db.query.task_links.findFirst({
    where: and(eq(task_links.from_task_id, id), eq(task_links.to_task_id, to_task_id)),
  });
  if (existing) throw new ValidationError("Link already exists between these tasks");

  const linkId = ulid();
  await db.insert(task_links).values({
    id: linkId,
    from_task_id: id,
    to_task_id,
    link_type,
    created_at: new Date(),
  });

  const link = await db.query.task_links.findFirst({ where: eq(task_links.id, linkId) });
  if (!link) throw new Error("Expected link to exist after write");
  return c.json(linkToDto(link), 201);
});

app.openapi(deleteLinkRoute, async (c) => {
  const db = getDb();
  const { id, linkId } = c.req.valid("param");

  const link = await db.query.task_links.findFirst({ where: eq(task_links.id, linkId) });
  if (!link || (link.from_task_id !== id && link.to_task_id !== id)) {
    throw new NotFoundError("TaskLink", linkId);
  }

  await db.delete(task_links).where(eq(task_links.id, linkId));
  return new Response(null, { status: 204 });
});

export { app as taskLinksRouter };
