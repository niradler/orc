import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import {
  createSkill,
  listSkills,
  type SkillFull,
  type SkillRefContent,
  type SkillSource,
  skillValidationIssues,
  skillWarnings,
} from "@orc/core/skill-service";
import { getSqlite } from "@orc/db/client";
import { readEvolvedSkill } from "@orc/db/skill-evolution";

const app = new OpenAPIHono();

const SkillMetaSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    source: z.enum(["builtin", "user"]),
    path: z.string(),
    metadata: z.record(z.string(), z.unknown()),
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
  files: z.array(SkillRefSchema),
}).openapi("SkillFull");

const SkillRefContentSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]),
  })
  .openapi("SkillRefContent");

const CreateSkillSchema = z
  .object({
    name: z.string().min(1).max(200),
    content: z.string().min(1),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(1024),
          content: z.string().max(12 * 1024 * 1024),
          encoding: z.enum(["utf8", "base64"]).optional(),
        }),
      )
      .max(512)
      .optional(),
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
      q: z.string().optional().openapi({ description: "Keyword search on name and description" }),
      source: z.enum(["builtin", "user"]).optional(),
      reload: z.coerce.boolean().optional().openapi({ description: "Force cache rebuild" }),
    }),
  },
  responses: {
    200: {
      description: "Skill list",
      content: {
        "application/json": {
          schema: z.object({
            skills: z.array(SkillMetaSchema),
            broken: z.array(z.object({ path: z.string(), error: z.string() })),
            warnings: z.array(z.object({ path: z.string(), message: z.string() })),
          }),
        },
      },
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
      ref: z.string().optional().openapi({
        description:
          "Skill-relative file path (e.g. scripts/check.py); bare filenames read references/",
      }),
      project_id: z.string().optional(),
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
    400: { description: "Invalid skill file path" },
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
  const { q, source, reload } = c.req.valid("query");
  const skills = listSkills({
    q,
    source: source as SkillSource | undefined,
    reload,
  });
  return c.json({ skills, broken: skillValidationIssues(), warnings: skillWarnings() });
});

app.openapi(readRoute, (c) => {
  const { name } = c.req.valid("param");
  const { ref, project_id } = c.req.valid("query");
  const result = readEvolvedSkill(getSqlite(), name, project_id ?? null, ref);
  if (!result) throw new NotFoundError("Skill", name);
  return c.json(result as SkillFull | SkillRefContent);
});

app.openapi(createRoute_, async (c) => {
  const { name, content, files } = c.req.valid("json");
  try {
    const skill = createSkill(name, content, files);
    return c.json(skill, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists")) {
      throw new ConflictError(msg);
    }
    if (msg.startsWith("Invalid SKILL.md")) throw new ValidationError(msg);
    throw err;
  }
});

export const skillsRouter = app;
