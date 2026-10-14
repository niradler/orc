import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { hiddenBuiltinSkills, updateGlobalConfig } from "@orc/core/config";
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
import { SkillUpdateSchema, WikiScopeSchema } from "@orc/core/wiki";
import { getSqlite } from "@orc/db/client";
import { SkillHistory } from "@orc/db/skill-history";
import { resolveWikiProject } from "./wiki.js";

const app = new OpenAPIHono();

const VisibilitySchema = z
  .object({ hidden_builtins: z.array(z.string().min(1).max(64)).max(512) })
  .strict();
app.openapi(
  createRoute({
    method: "get",
    path: "/skills/settings/visibility",
    tags: ["Skills"],
    summary: "Get installation-wide built-in discovery visibility",
    responses: {
      200: {
        description: "Visibility policy",
        content: { "application/json": { schema: VisibilitySchema } },
      },
    },
  }),
  (c) => c.json({ hidden_builtins: hiddenBuiltinSkills() }),
);

app.openapi(
  createRoute({
    method: "put",
    path: "/skills/settings/visibility",
    tags: ["Skills"],
    summary: "Set installation-wide built-in discovery visibility",
    request: {
      body: { required: true, content: { "application/json": { schema: VisibilitySchema } } },
    },
    responses: {
      200: {
        description: "Saved visibility policy",
        content: { "application/json": { schema: VisibilitySchema } },
      },
      400: { description: "Only built-in skills can be hidden" },
    },
  }),
  (c) => {
    const { hidden_builtins } = c.req.valid("json");
    const builtins = new Set(
      listSkills({ source: "builtin", include_hidden: true }).map((skill) => skill.name),
    );
    for (const name of hiddenBuiltinSkills()) builtins.add(name);
    if (hidden_builtins.some((name) => !builtins.has(name)))
      throw new ValidationError("Only installed built-in skills can be hidden");
    const names = [...new Set(hidden_builtins)].sort();
    updateGlobalConfig((raw) => {
      raw.skills = {
        ...(raw.skills as Record<string, unknown> | undefined),
        hidden_builtins: names,
      };
    });
    return c.json({ hidden_builtins: names });
  },
);

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

const SkillMutationSchema = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  updated_at: z.number(),
  author: z.string(),
});
const SkillChangeSchema = z
  .object({
    id: z.string(),
    project_id: z.string().nullable(),
    skill_name: z.string(),
    raw: z.string(),
    previous_raw: z.string(),
    reason: z.string(),
    author: z.string(),
    session_id: z.string().nullable(),
    action: z.string(),
    created_at: z.number(),
  })
  .openapi("SkillChange");
const SkillMetaSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    source: z.enum(["builtin", "user"]),
    path: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    mutation: SkillMutationSchema.optional(),
    discovery_hidden: z.boolean().optional(),
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
      ...WikiScopeSchema.shape,
      q: z.string().optional().openapi({ description: "Keyword search on name and description" }),
      source: z.enum(["builtin", "user"]).optional(),
      reload: z.coerce.boolean().optional().openapi({ description: "Force cache rebuild" }),
      include_hidden: z
        .enum(["true", "false"])
        .transform((value) => value === "true")
        .optional(),
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
      ...WikiScopeSchema.shape,
      ref: z.string().optional().openapi({
        description:
          "Skill-relative file path (e.g. scripts/check.py); bare filenames read references/",
      }),
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
    method: "put",
    path: "/skills/{name}/instructions",
    tags: ["Skills"],
    summary: "Apply an audited instruction edit without changing supporting files",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object(SkillUpdateSchema.omit({ skill_name: true }).shape).strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Edited effective skill",
        content: { "application/json": { schema: SkillFullSchema } },
      },
      409: { description: "Stale current instructions" },
    },
  }),
  (c) =>
    c.json(
      new SkillHistory(getSqlite()).update({
        ...c.req.valid("json"),
        skill_name: c.req.valid("param").name,
      }),
    ),
);
app.openapi(
  createRoute({
    method: "get",
    path: "/skills/{name}/history",
    tags: ["Skills"],
    summary: "Instruction history for the resolved skill scope",
    request: { params: z.object({ name: z.string() }), query: WikiScopeSchema },
    responses: {
      200: {
        description: "Retained changes",
        content: {
          "application/json": { schema: z.object({ changes: z.array(SkillChangeSchema) }) },
        },
      },
    },
  }),
  (c) =>
    c.json({
      changes: new SkillHistory(getSqlite()).history(
        c.req.valid("param").name,
        resolveWikiProject(c.req.valid("query")),
      ),
    }),
);
app.openapi(
  createRoute({
    method: "post",
    path: "/skills/{name}/revert",
    tags: ["Skills"],
    summary: "Manually revert an instruction edit with a stale-state guard",
    request: {
      params: z.object({ name: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                project_id: z.string().nullable(),
                change_id: z.string().min(1),
                expected_change_id: z.string().min(1),
                reason: z.string().trim().min(1).max(2000),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Reverted effective skill",
        content: { "application/json": { schema: SkillFullSchema } },
      },
      409: { description: "Skill changed since review" },
    },
  }),
  (c) => {
    const input = c.req.valid("json");
    return c.json(
      new SkillHistory(getSqlite()).revert(
        c.req.valid("param").name,
        input.project_id,
        input.change_id,
        input.expected_change_id,
        input.reason,
      ),
    );
  },
);

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
  const { q, source, reload, include_hidden } = c.req.valid("query");
  const skills = new SkillHistory(getSqlite()).list(resolveWikiProject(c.req.valid("query")), {
    q,
    source: source as SkillSource | undefined,
    reload,
    include_hidden,
  });
  return c.json({
    skills,
    broken: skillValidationIssues(),
    warnings: skillWarnings(),
  });
});

app.openapi(readRoute, (c) => {
  const { name } = c.req.valid("param");
  const { ref } = c.req.valid("query");
  const result = new SkillHistory(getSqlite()).read(
    name,
    resolveWikiProject(c.req.valid("query")),
    ref,
  );
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
