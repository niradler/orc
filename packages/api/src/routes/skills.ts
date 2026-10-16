import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { hiddenBuiltinSkills, updateGlobalConfig } from "@orc/core/config";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { editSkillFile } from "@orc/core/skill-edit";
import {
  discoverRepositorySkills,
  getSkillImportOrigin,
  importRepositorySkills,
} from "@orc/core/skill-import";
import { importLocalAgentSkills, listLocalAgentSkills } from "@orc/core/skill-local-import";
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
import { SkillHistory, type SkillReadSource } from "@orc/db/skill-history";
import { resolveWikiProject } from "./wiki.js";

const app = new OpenAPIHono();

const ORC_CLIENT_HEADER = "X-Orc-Client";

/** Attributes a skill read to the calling client; unknown callers count as plain API reads. */
function readSource(client: string | undefined): SkillReadSource {
  return client === "cli" || client === "ui" ? client : "api";
}

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

const SkillListItemSchema = SkillMetaSchema.extend({
  read_count: z
    .number()
    .int()
    .openapi({ description: "Agent reads (mcp + cli + api) of the skill entry point" }),
  reads_by_source: z
    .object({
      mcp: z.number().int(),
      cli: z.number().int(),
      api: z.number().int(),
      ui: z.number().int(),
    })
    .openapi({ description: "Entry-point reads per source; ui is not counted in read_count" }),
  ref_read_count: z.number().int().openapi({ description: "Reads of supporting files" }),
  last_read_at: z.number().int().nullable(),
  activity_at: z
    .number()
    .int()
    .openapi({ description: "Last read, else last update, else file creation (epoch seconds)" }),
}).openapi("SkillListItem");

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
      q: z.string().optional().openapi({ description: "Full-text search on name and description" }),
      source: z.enum(["builtin", "user"]).optional(),
      sort: z.enum(["reads", "recent"]).optional().openapi({
        description:
          "reads (default): most read first; recent: last read, updated or created first",
      }),
      limit: z.coerce.number().int().min(1).max(500).optional(),
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
            skills: z.array(SkillListItemSchema),
            total: z.number().int(),
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

const LocalSkillSchema = z
  .object({
    agent: z.string(),
    name: z.string(),
    description: z.string(),
    path: z.string(),
    content_hash: z.string(),
    status: z.enum(["new", "installed", "conflict", "changed", "invalid"]),
    also_in: z.array(z.string()),
    extra_fields: z.array(z.string()),
    error: z.string().optional(),
  })
  .openapi("LocalSkill");
const LocalSkillItemSchema = z.object({ agent: z.string().max(64), name: z.string().max(64) });

app.openapi(
  createRoute({
    method: "get",
    path: "/skills/local-agents",
    tags: ["Skills"],
    summary: "List skills installed for local coding agents (~/.claude, ~/.codex, ...)",
    responses: {
      200: {
        description: "Agents with their skills and import status",
        content: {
          "application/json": {
            schema: z.object({
              agents: z.array(
                z.object({
                  id: z.string(),
                  label: z.string(),
                  dir: z.string(),
                  skills: z.array(LocalSkillSchema),
                }),
              ),
            }),
          },
        },
      },
    },
  }),
  (c) => c.json({ agents: listLocalAgentSkills() }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/skills/local-agents/import",
    tags: ["Skills"],
    summary: "Copy selected local agent skills into ORC",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ skills: z.array(LocalSkillItemSchema).min(1).max(200) }).strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Imported skills and the ones skipped with a reason",
        content: {
          "application/json": {
            schema: z.object({
              imported: z.array(
                z.object({ name: z.string(), description: z.string(), path: z.string() }),
              ),
              skipped: z.array(LocalSkillItemSchema.extend({ reason: z.string() })),
            }),
          },
        },
      },
      400: { description: "Invalid selection" },
    },
  }),
  (c) => c.json(importLocalAgentSkills(c.req.valid("json").skills)),
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
  const { q, source, sort, limit, reload, include_hidden } = c.req.valid("query");
  const skills = new SkillHistory(getSqlite()).list(resolveWikiProject(c.req.valid("query")), {
    q,
    source: source as SkillSource | undefined,
    sort,
    reload,
    include_hidden,
  });
  return c.json({
    skills: limit === undefined ? skills : skills.slice(0, limit),
    total: skills.length,
    broken: skillValidationIssues(),
    warnings: skillWarnings(),
  });
});

app.openapi(readRoute, (c) => {
  const { name } = c.req.valid("param");
  const { ref } = c.req.valid("query");
  const projectId = resolveWikiProject(c.req.valid("query"));
  const history = new SkillHistory(getSqlite());
  const result = history.read(name, projectId, ref);
  if (!result) throw new NotFoundError("Skill", name);
  history.recordRead(name, projectId, readSource(c.req.header(ORC_CLIENT_HEADER)), ref);
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
