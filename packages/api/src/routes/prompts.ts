import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { NotFoundError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { getDb } from "@orc/db/client";
import { prompt_history, prompts } from "@orc/db/schema";
import { desc, eq } from "drizzle-orm";

const app = new OpenAPIHono();

const PromptSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    template: z.string(),
    is_skill: z.boolean(),
    skill_dir: z.string().nullable(),
    skill_version: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    version: z.number(),
    pinned: z.boolean(),
    last_used_at: z.string().datetime().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("Prompt");

const CreatePromptSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    template: z.string().min(1),
    is_skill: z.boolean().optional().default(false),
    skill_dir: z.string().optional(),
    skill_version: z.string().optional(),
    tags: z.array(z.string()).optional(),
    pinned: z.boolean().optional().default(false),
  })
  .openapi("CreatePrompt");

const UpdatePromptSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().optional(),
    template: z.string().min(1).optional(),
    is_skill: z.boolean().optional(),
    skill_dir: z.string().optional(),
    skill_version: z.string().optional(),
    tags: z.array(z.string()).optional(),
    pinned: z.boolean().optional(),
  })
  .openapi("UpdatePrompt");

const RenderSchema = z
  .object({
    vars: z.record(z.string()).optional().default({}),
  })
  .openapi("RenderPrompt");

const listRoute = createRoute({
  method: "get",
  path: "/prompts",
  tags: ["Prompts"],
  summary: "List prompts",
  request: {
    query: z.object({
      is_skill: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    }),
  },
  responses: {
    200: {
      description: "Prompts",
      content: { "application/json": { schema: z.object({ prompts: z.array(PromptSchema) }) } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/prompts/{id}",
  tags: ["Prompts"],
  summary: "Get prompt by ID",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Prompt", content: { "application/json": { schema: PromptSchema } } },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/prompts",
  tags: ["Prompts"],
  summary: "Create prompt",
  request: { body: { content: { "application/json": { schema: CreatePromptSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: PromptSchema } } },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/prompts/{id}",
  tags: ["Prompts"],
  summary: "Update prompt (bumps version)",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: UpdatePromptSchema } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: PromptSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/prompts/{id}",
  tags: ["Prompts"],
  summary: "Delete prompt",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: "Deleted" },
  },
});

const renderRoute = createRoute({
  method: "post",
  path: "/prompts/{id}/render",
  tags: ["Prompts"],
  summary: "Render prompt with variable interpolation",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: RenderSchema } } },
  },
  responses: {
    200: {
      description: "Rendered",
      content: {
        "application/json": {
          schema: z
            .object({ rendered: z.string(), prompt_id: z.string(), version: z.number() })
            .openapi("RenderedPrompt"),
        },
      },
    },
  },
});

const PromptHistoryEntrySchema = z
  .object({
    id: z.string(),
    prompt_id: z.string(),
    version: z.number(),
    name: z.string(),
    description: z.string().nullable(),
    template: z.string(),
    tags: z.array(z.string()).nullable(),
    changed_by: z.string(),
    changed_at: z.string().datetime(),
  })
  .openapi("PromptHistoryEntry");

const historyRoute = createRoute({
  method: "get",
  path: "/prompts/{id}/history",
  tags: ["Prompts"],
  summary: "List prompt version history (newest first)",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: "History",
      content: {
        "application/json": {
          schema: z.object({ history: z.array(PromptHistoryEntrySchema) }),
        },
      },
    },
  },
});

function toDto(p: typeof prompts.$inferSelect) {
  return {
    ...p,
    last_used_at: p.last_used_at?.toISOString() ?? null,
    created_at: p.created_at.toISOString(),
    updated_at: p.updated_at.toISOString(),
  };
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

app.openapi(listRoute, async (c) => {
  const db = getDb();
  const { is_skill, limit } = c.req.valid("query");
  const rows = await db.query.prompts.findMany({
    where: is_skill !== undefined ? eq(prompts.is_skill, is_skill) : undefined,
    limit,
    orderBy: (p, { asc }) => [asc(p.name)],
  });
  return c.json({ prompts: rows.map(toDto) });
});

app.openapi(getRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const prompt = await db.query.prompts.findFirst({ where: eq(prompts.id, id) });
  if (!prompt) throw new NotFoundError("Prompt", id);
  return c.json(toDto(prompt));
});

app.openapi(createRoute_, async (c) => {
  const db = getDb();
  const body = c.req.valid("json");
  const now = new Date();
  const id = ulid();

  await db.insert(prompts).values({
    id,
    name: body.name,
    description: body.description,
    template: body.template,
    is_skill: body.is_skill,
    skill_dir: body.skill_dir,
    skill_version: body.skill_version,
    tags: body.tags,
    pinned: body.pinned,
    created_at: now,
    updated_at: now,
  });

  const prompt = await db.query.prompts.findFirst({ where: eq(prompts.id, id) });
  return c.json(toDto(prompt!), 201);
});

app.openapi(updateRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const existing = await db.query.prompts.findFirst({ where: eq(prompts.id, id) });
  if (!existing) throw new NotFoundError("Prompt", id);

  await db.insert(prompt_history).values({
    id: ulid(),
    prompt_id: existing.id,
    version: existing.version,
    name: existing.name,
    description: existing.description,
    template: existing.template,
    tags: existing.tags,
    changed_by: "human",
    changed_at: new Date(),
  });

  await db
    .update(prompts)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.template !== undefined ? { template: body.template } : {}),
      ...(body.is_skill !== undefined ? { is_skill: body.is_skill } : {}),
      ...(body.skill_dir !== undefined ? { skill_dir: body.skill_dir } : {}),
      ...(body.skill_version !== undefined ? { skill_version: body.skill_version } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      version: existing.version + 1,
      updated_at: new Date(),
    })
    .where(eq(prompts.id, id));

  const updated = await db.query.prompts.findFirst({ where: eq(prompts.id, id) });
  return c.json(toDto(updated!));
});

app.openapi(deleteRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const existing = await db.query.prompts.findFirst({ where: eq(prompts.id, id) });
  if (!existing) throw new NotFoundError("Prompt", id);
  await db.delete(prompts).where(eq(prompts.id, id));
  return new Response(null, { status: 204 });
});

app.openapi(renderRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const { vars } = c.req.valid("json");

  const prompt = await db.query.prompts.findFirst({ where: eq(prompts.id, id) });
  if (!prompt) throw new NotFoundError("Prompt", id);

  await db.update(prompts).set({ last_used_at: new Date() }).where(eq(prompts.id, id));

  return c.json({
    rendered: interpolate(prompt.template, vars ?? {}),
    prompt_id: prompt.id,
    version: prompt.version,
  });
});

function historyToDto(h: typeof prompt_history.$inferSelect) {
  return {
    ...h,
    changed_at: h.changed_at.toISOString(),
  };
}

app.openapi(historyRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const { limit } = c.req.valid("query");

  const prompt = await db.query.prompts.findFirst({ where: eq(prompts.id, id) });
  if (!prompt) throw new NotFoundError("Prompt", id);

  const rows = await db.query.prompt_history.findMany({
    where: eq(prompt_history.prompt_id, id),
    limit,
    orderBy: [desc(prompt_history.version)],
  });

  return c.json({ history: rows.map(historyToDto) });
});

export { app as promptsRouter };
