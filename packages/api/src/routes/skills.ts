import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { editSkillFile } from "@orc/core/skill-edit";
import {
  discoverRepositorySkills,
  getSkillImportOrigin,
  importRepositorySkills,
} from "@orc/core/skill-import";
import {
  createSkill,
  listSkills,
  type SkillFull,
  type SkillRefContent,
  type SkillSource,
  skillValidationIssues,
  skillWarnings,
} from "@orc/core/skill-service";
import { syncImportedSkill } from "@orc/core/skill-sync";
import { getSqlite } from "@orc/db/client";
import { readEvolvedSkill } from "@orc/db/skill-evolution";

const app = new OpenAPIHono();

const OriginSchema = z.object({
  repository: z.string(),
  ref: z.string(),
  path: z.string(),
  skill: z.string().optional(),
  commit: z.string(),
  importedAt: z.string(),
});
const DiscoverySchema = z.object({
  repository: z.string(),
  ref: z.string(),
  path: z.string(),
  skill: z.string().optional(),
  commit: z.string(),
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      path: z.string(),
      installed: z.boolean(),
    }),
  ),
  issues: z.array(z.object({ path: z.string(), error: z.string() })),
});

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

app.openapi(
  createRoute({
    method: "post",
    path: "/skills/discover",
    tags: ["Skills"],
    summary: "Discover skills in a public GitHub repository",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ source: z.string().min(1).max(2048) }).strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Available skills at a pinned commit",
        content: { "application/json": { schema: DiscoverySchema } },
      },
      400: { description: "Invalid source or repository" },
    },
  }),
  async (c) => c.json(await discoverRepositorySkills(c.req.valid("json").source)),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/skills/import",
    tags: ["Skills"],
    summary: "Import selected GitHub skill folders",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                source: z.string().min(1).max(2048),
                commit: z.string().regex(/^[a-f0-9]{40}$/),
                paths: z.array(z.string().max(1024)).min(1).max(16),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Imported skills",
        content: { "application/json": { schema: z.object({ skills: z.array(SkillFullSchema) }) } },
      },
      400: { description: "Invalid import" },
      409: { description: "Skill already exists" },
    },
  }),
  async (c) => c.json({ skills: await importRepositorySkills(c.req.valid("json")) }, 201),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/skills/{name}/origin",
    tags: ["Skills"],
    summary: "Get skill import provenance",
    request: { params: z.object({ name: z.string() }) },
    responses: {
      200: {
        description: "Import origin or null",
        content: { "application/json": { schema: OriginSchema.nullable() } },
      },
    },
  }),
  (c) => c.json(getSkillImportOrigin(c.req.valid("param").name)),
);

app.openapi(
  createRoute({
    method: "put",
    path: "/skills/{name}/file",
    tags: ["Skills"],
    summary: "Edit an existing user skill text file",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                path: z.string().min(1).max(1024),
                content: z.string().max(8 * 1024 * 1024),
                expectedContent: z.string().max(8 * 1024 * 1024),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated skill",
        content: { "application/json": { schema: SkillFullSchema } },
      },
      400: { description: "Invalid skill edit" },
      404: { description: "Skill or file missing" },
      409: { description: "File changed since opening" },
    },
  }),
  (c) => {
    const { path, content, expectedContent } = c.req.valid("json");
    return c.json(editSkillFile(c.req.valid("param").name, path, content, expectedContent));
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/skills/{name}/sync",
    tags: ["Skills"],
    summary:
      "Sync an imported skill; preserve local edits unless reviewed conflicts are overridden",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                override: z.boolean().optional(),
                expectedCommit: z
                  .string()
                  .regex(/^[a-f0-9]{40}$/)
                  .optional(),
                expectedRevision: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .optional(),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Applied update or conflict report",
        content: {
          "application/json": {
            schema: z.object({
              applied: z.boolean(),
              commit: z.string(),
              revision: z.string(),
              changed: z.array(z.string()),
              conflicts: z.array(z.string()),
            }),
          },
        },
      },
      400: { description: "Invalid sync" },
      404: { description: "Skill missing" },
      409: { description: "Review is stale" },
    },
  }),
  async (c) => c.json(await syncImportedSkill(c.req.valid("param").name, c.req.valid("json"))),
);

app.openapi(listRoute, (c) => {
  const { q, source, reload } = c.req.valid("query");
  const skills = listSkills({
    q,
    source: source as SkillSource | undefined,
    reload,
  });
  return c.json({
    skills,
    broken: skillValidationIssues(),
    warnings: skillWarnings(),
  });
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
