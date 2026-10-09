import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { configuredEmbeddingProvider } from "@orc/core/embedding-provider";
import { NotFoundError } from "@orc/core/errors";
import { EvidenceSourceSchema, RetrievalQuerySchema } from "@orc/core/retrieval";
import { getSqlite } from "@orc/db/client";
import { syncProjectEvidence } from "@orc/db/evidence-sync";
import { PassageIndex } from "@orc/db/retrieval";

const app = new OpenAPIHono();
const PassageSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  version: z.string(),
  kind: z.enum(["memory", "document", "session", "wiki"]),
  project_id: z.string().nullable(),
  title: z.string(),
  location: z.string(),
  headings: z.array(z.string()),
  structural_context: z.string().nullable(),
  start: z.number(),
  end: z.number(),
  content: z.string(),
  ordinal: z.number(),
  tags: z.array(z.string()),
});
const ResultSchema = z.object({
  passages: z.array(PassageSchema.extend({ score: z.number(), estimated_tokens: z.number() })),
  estimated_tokens: z.number(),
  capabilities: z.object({
    lexical: z.literal(true),
    semantic: z.enum(["off", "ready", "degraded"]),
    reason: z.string().optional(),
  }),
});

app.openapi(
  createRoute({
    method: "post",
    path: "/knowledge/passages/search",
    tags: ["Knowledge"],
    request: { body: { content: { "application/json": { schema: RetrievalQuerySchema } } } },
    responses: {
      200: {
        description: "Current cited passages within an estimated token budget",
        content: { "application/json": { schema: ResultSchema } },
      },
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const sqlite = getSqlite();
    const index = new PassageIndex(sqlite, configuredEmbeddingProvider());
    syncProjectEvidence(sqlite, input.project_id, index);
    return c.json(await index.search(input), 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/knowledge/passages/index",
    tags: ["Knowledge"],
    request: { body: { content: { "application/json": { schema: EvidenceSourceSchema } } } },
    responses: {
      200: {
        description: "Indexed source version",
        content: { "application/json": { schema: z.object({ version: z.string() }) } },
      },
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const sqlite = getSqlite();
    if (
      input.project_id &&
      !sqlite.query("SELECT id FROM projects WHERE id=?").get(input.project_id)
    )
      throw new NotFoundError("Project", input.project_id);
    return c.json({ version: new PassageIndex(sqlite).put(input) }, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/knowledge/passages/expand",
    tags: ["Knowledge"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              id: z.string(),
              project_id: z.string().nullable(),
              radius: z.number().int().min(0).max(3).default(1),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Neighboring current source passages",
        content: { "application/json": { schema: z.object({ passages: z.array(PassageSchema) }) } },
      },
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    return c.json(
      { passages: new PassageIndex(getSqlite()).expand(input.id, input.project_id, input.radius) },
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/knowledge/passages/embed",
    tags: ["Knowledge"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              kind: z.enum(["memory", "document", "session", "wiki"]),
              source_id: z.string(),
              project_id: z.string().nullable(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Explicit embedding generation",
        content: {
          "application/json": {
            schema: z.object({
              embedded: z.number(),
              semantic: z.enum(["off", "ready", "degraded"]),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const source = getSqlite()
      .query(
        "SELECT source_id FROM evidence_sources WHERE kind=? AND source_id=? AND project_id IS ? AND active=1",
      )
      .get(input.kind, input.source_id, input.project_id);
    if (!source) throw new NotFoundError("Evidence source", input.source_id);
    const provider = configuredEmbeddingProvider();
    if (!provider) return c.json({ embedded: 0, semantic: "off" as const }, 200);
    const embedded = await new PassageIndex(getSqlite(), provider).embedSource(
      input.kind,
      input.source_id,
    );
    return c.json({ embedded, semantic: "ready" as const }, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/knowledge/passages/get",
    tags: ["Knowledge"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              ids: z.array(z.string()).min(1).max(20),
              project_id: z.string().nullable(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Explicit immutable citations, including archived source versions",
        content: { "application/json": { schema: z.object({ passages: z.array(PassageSchema) }) } },
      },
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    return c.json(
      { passages: new PassageIndex(getSqlite()).get(input.ids, input.project_id) },
      200,
    );
  },
);

export { app as retrievalRouter };
