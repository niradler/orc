import { createRoute, z } from "@hono/zod-openapi";
import { skillVisibility, updateGlobalConfig } from "@orc/core/config";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { ScopeQuerySchema } from "@orc/core/scope";
import { MAX_SKILL_DOWNLOAD_TOKEN_CHARS, SkillDownloadSchema } from "@orc/core/skill-download";
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
import { SkillUpdateSchema } from "@orc/core/skill-update";
import { getSqlite } from "@orc/db/client";
import { readSourceFromHeader } from "@orc/db/read-usage";
import { SkillHistory } from "@orc/db/skill-history";
import { createRouter } from "../lib/router.js";
import { resolveScopeProject } from "../lib/scope.js";
import { skillDownloads } from "../skill-downloads.js";

const app = createRouter();

app.openapi(
  createRoute({
    method: "get",
    path: "/skills/{name}/projects",
    tags: ["Skills"],
    summary: "Read skill project assignments; an empty list means global",
    request: { params: z.object({ name: z.string().min(1).max(100) }) },
    responses: {
      200: {
        description: "Project assignments",
        content: {
          "application/json": {
            schema: z.object({ project_ids: z.array(z.string()) }),
          },
        },
      },
      404: { description: "Skill not found" },
    },
  }),
  (c) => {
    const name = c.req.valid("param").name;
    if (!listSkills({ include_hidden: true }).some((skill) => skill.name === name))
      throw new NotFoundError("Skill", name);
    return c.json({ project_ids: new SkillHistory(getSqlite()).projectIds(name) });
  },
);

app.openapi(
  createRoute({
    method: "put",
    path: "/skills/{name}/projects",
    tags: ["Skills"],
    summary: "Replace skill project assignments; an empty list makes the skill global",
    request: {
      params: z.object({ name: z.string().min(1).max(100) }),
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z
              .object({
                project_ids: z.array(z.string().min(1).max(200)).max(500),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Project assignments",
        content: {
          "application/json": {
            schema: z.object({ project_ids: z.array(z.string()) }),
          },
        },
      },
      400: { description: "Invalid assignments" },
      404: { description: "Skill or project not found" },
    },
  }),
  (c) =>
    c.json({
      project_ids: new SkillHistory(getSqlite()).setProjects(
        c.req.valid("param").name,
        c.req.valid("json").project_ids,
      ),
    }),
);

const ORC_SOURCE_HEADER = "X-Orc-Source";

app.openapi(
  createRoute({
    method: "post",
    path: "/skills/{name}/download",
    tags: ["Skills"],
    summary: "Mint a ten-minute signed download for one version of a skill file",
    request: {
      params: z.object({ name: z.string().min(1).max(64) }),
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z
              .object({
                ref: z.string().min(1).max(1024),
                ...ScopeQuerySchema.shape,
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Download capability; keep its URL private",
        content: { "application/json": { schema: SkillDownloadSchema } },
      },
      400: { description: "Invalid file path or scope" },
      401: { description: "Authentication required" },
      404: { description: "Skill or file missing" },
    },
  }),
  (c) => {
    const input = c.req.valid("json");
    const result = skillDownloads.mint(
      c.req.valid("param").name,
      input.ref,
      resolveScopeProject(input),
      new URL(c.req.url).origin,
    );
    c.header("Cache-Control", "no-store");
    return c.json(result);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/skills/download/{token}",
    tags: ["Skills"],
    summary: "Download exact skill-file bytes using a signed capability",
    request: { params: z.object({ token: z.string().max(MAX_SKILL_DOWNLOAD_TOKEN_CHARS) }) },
    responses: {
      200: {
        description: "Original file; downloading never executes it",
        content: {
          "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
        },
      },
      401: { description: "Invalid or expired capability" },
      404: { description: "File no longer exists" },
      409: { description: "File changed since the capability was issued" },
    },
  }),
  (c) => {
    const { bytes, filename } = skillDownloads.read(c.req.valid("param").token);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(new Uint8Array(bytes));
  },
);

const VisibilitySchema = z
  .object({
    hidden_builtins: z.array(z.string().min(1).max(64)).max(512),
    hidden_skills: z.array(z.string().min(1).max(64)).max(512),
  })
  .strict();
const VisibilityUpdateSchema = VisibilitySchema.partial().refine(
  (policy) => policy.hidden_builtins !== undefined || policy.hidden_skills !== undefined,
  "Provide hidden_skills or hidden_builtins",
);
app.openapi(
  createRoute({
    method: "get",
    path: "/skills/settings/visibility",
    tags: ["Skills"],
    summary: "Get installation-wide skill discovery visibility",
    responses: {
      200: {
        description: "Visibility policy",
        content: { "application/json": { schema: VisibilitySchema } },
      },
    },
  }),
  (c) => c.json(skillVisibility()),
);

app.openapi(
  createRoute({
    method: "put",
    path: "/skills/settings/visibility",
    tags: ["Skills"],
    summary: "Set installation-wide skill discovery visibility",
    request: {
      body: { required: true, content: { "application/json": { schema: VisibilityUpdateSchema } } },
    },
    responses: {
      200: {
        description: "Saved visibility policy",
        content: { "application/json": { schema: VisibilitySchema } },
      },
      400: { description: "Invalid skill visibility policy" },
    },
  }),
  (c) => {
    const input = c.req.valid("json");
    const current = skillVisibility();
    const installed = listSkills({ include_hidden: true });
    const builtins = new Set(
      installed.filter((skill) => skill.source === "builtin").map((skill) => skill.name),
    );
    for (const name of current.hidden_builtins) builtins.add(name);
    if (input.hidden_builtins?.some((name) => !builtins.has(name)))
      throw new ValidationError("Only installed built-in skills can be hidden");
    const skills = new Set([...installed.map((skill) => skill.name), ...current.hidden_skills]);
    if (input.hidden_skills?.some((name) => !skills.has(name)))
      throw new ValidationError("Only installed skills can be hidden");
    const policy = {
      hidden_builtins: [...new Set(input.hidden_builtins ?? current.hidden_builtins)].sort(),
      hidden_skills: [...new Set(input.hidden_skills ?? current.hidden_skills)].sort(),
    };
    updateGlobalConfig((raw) => {
      raw.skills = {
        ...(raw.skills as Record<string, unknown> | undefined),
        ...policy,
      };
    });
    return c.json(policy);
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
  project_ids: z.array(z.string()),
  score: z
    .number()
    .optional()
    .openapi({ description: "Relative search relevance; higher is better" }),
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
      ...ScopeQuerySchema.shape,
      q: z
        .string()
        .max(500)
        .optional()
        .openapi({ description: "Hybrid lexical search; results sorted by relevance" }),
      source: z.enum(["builtin", "user"]).optional(),
      sort: z.enum(["reads", "recent"]).optional().openapi({
        description:
          "reads (default): most read first; recent: last read, updated or created first",
      }),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
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
            offset: z.number().int(),
            limit: z.number().int(),
            next_offset: z.number().int().nullable(),
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
      ...ScopeQuerySchema.shape,
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
    request: { params: z.object({ name: z.string() }), query: ScopeQuerySchema },
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
        resolveScopeProject(c.req.valid("query")),
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
  const { q, source, sort, limit = 30, offset = 0, reload, include_hidden } = c.req.valid("query");
  const skills = new SkillHistory(getSqlite()).list(resolveScopeProject(c.req.valid("query")), {
    q,
    source: source as SkillSource | undefined,
    sort,
    reload,
    include_hidden,
  });
  return c.json({
    skills: skills.slice(offset, offset + limit),
    total: skills.length,
    offset,
    limit,
    next_offset: offset + limit < skills.length ? offset + limit : null,
    broken: skillValidationIssues(),
    warnings: skillWarnings(),
  });
});

app.openapi(readRoute, (c) => {
  const { name } = c.req.valid("param");
  const { ref } = c.req.valid("query");
  const projectId = resolveScopeProject(c.req.valid("query"));
  const history = new SkillHistory(getSqlite());
  const result = history.read(name, projectId, ref);
  if (!result) throw new NotFoundError("Skill", name);
  history.recordRead(name, projectId, readSourceFromHeader(c.req.header(ORC_SOURCE_HEADER)), ref);
  return c.json(result as SkillFull | SkillRefContent);
});

app.openapi(createRoute_, async (c) => {
  const { name, content, files } = c.req.valid("json");
  try {
    const skill = createSkill(name, content, files, { authored: true });
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
