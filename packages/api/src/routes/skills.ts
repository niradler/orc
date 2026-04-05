import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ConflictError, NotFoundError } from "@orc/core/errors";
import {
  createSkill,
  listSkills,
  readSkill,
  type SkillFull,
  type SkillMeta,
  type SkillRefContent,
  type SkillSource,
} from "@orc/core/skill-service";

const app = new OpenAPIHono();

const SkillMetaSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    version: z.string(),
    source: z.enum(["builtin", "user"]),
    path: z.string(),
    dir: z.string(),
    frontmatter: z.record(z.unknown()),
  })
  .openapi("SkillMeta");

const SkillRefSchema = z
  .object({
    name: z.string(),
    path: z.string(),
  })
  .openapi("SkillRef");

const SkillFullSchema = SkillMetaSchema.extend({
  content: z.string(),
  references: z.array(SkillRefSchema),
}).openapi("SkillFull");

const SkillRefContentSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    content: z.string(),
  })
  .openapi("SkillRefContent");

const CreateSkillSchema = z
  .object({
    name: z.string().min(1).max(200),
    content: z.string().min(1),
  })
  .openapi("CreateSkill");

// --- Routes ---

const listRoute = createRoute({
  method: "get",
  path: "/skills",
  tags: ["Skills"],
  summary: "List installed skills",
  request: {
    query: z.object({
      q: z
        .string()
        .optional()
        .openapi({ description: "Keyword search on name, description, tags" }),
      tags: z.string().optional().openapi({ description: "Comma-separated tag filter" }),
      source: z.enum(["builtin", "user"]).optional(),
      reload: z.coerce.boolean().optional().openapi({ description: "Force cache rebuild" }),
    }),
  },
  responses: {
    200: {
      description: "Skill list",
      content: { "application/json": { schema: z.object({ skills: z.array(SkillMetaSchema) }) } },
    },
  },
});

const readRoute = createRoute({
  method: "get",
  path: "/skills/{name}",
  tags: ["Skills"],
  summary: "Read a skill by name",
  request: {
    params: z.object({ name: z.string() }),
    query: z.object({
      ref: z
        .string()
        .optional()
        .openapi({ description: "Reference filename to read instead of SKILL.md" }),
    }),
  },
  responses: {
    200: {
      description: "Skill content or reference file content",
      content: {
        "application/json": {
          schema: z.union([SkillFullSchema, SkillRefContentSchema]),
        },
      },
    },
    404: { description: "Skill not found" },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/skills",
  tags: ["Skills"],
  summary: "Create a new user skill",
  request: {
    body: { content: { "application/json": { schema: CreateSkillSchema } } },
  },
  responses: {
    201: {
      description: "Created skill",
      content: { "application/json": { schema: SkillFullSchema } },
    },
    400: { description: "Validation error" },
    409: { description: "Skill already exists" },
  },
});

// --- Handlers ---

app.openapi(listRoute, (c) => {
  const { q, tags, source, reload } = c.req.valid("query");
  const parsedTags = tags
    ? tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;
  const skills = listSkills({
    q,
    tags: parsedTags,
    source: source as SkillSource | undefined,
    reload,
  });
  return c.json({ skills });
});

app.openapi(readRoute, (c) => {
  const { name } = c.req.valid("param");
  const { ref } = c.req.valid("query");
  const result = readSkill(name, ref);
  if (!result) throw new NotFoundError("Skill", name);
  return c.json(result as SkillFull | SkillRefContent);
});

app.openapi(createRoute_, async (c) => {
  const { name, content } = c.req.valid("json");
  try {
    const skill = createSkill(name, content);
    return c.json(skill, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) {
      throw new ConflictError(msg);
    }
    throw err;
  }
});

export const skillsRouter = app;
