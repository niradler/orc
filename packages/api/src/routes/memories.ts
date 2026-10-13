import type { Database } from "bun:sqlite";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { NotFoundError } from "@orc/core/errors";
import { getDb, getSqlite } from "@orc/db/client";
import { MemoryStore, SIMILAR_MEMORY_HINT } from "@orc/db/memories";
import { memories } from "@orc/db/schema";
import { eq } from "drizzle-orm";

const app = new OpenAPIHono();
const API_ACTOR = "api";

const MemoryTypeSchema = z.enum(["fact", "decision", "event", "rule", "discovery"]);

const MemorySchema = z
  .object({
    id: z.string(),
    title: z.string().nullable(),
    type: MemoryTypeSchema,
    content: z.string(),
    source: z.string().nullable(),
    scope: z.string().nullable(),
    project_id: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    importance: z.enum(["low", "normal", "high", "critical"]),
    expires_at: z.string().datetime().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("Memory");

const CreateMemorySchema = z
  .object({
    content: z.string().min(1).max(2_000_000),
    title: z.string().optional(),
    type: MemoryTypeSchema.optional().default("fact"),
    source: z.string().optional(),
    session_id: z.string().min(1).max(200).optional(),
    scope: z.string().optional(),
    project_id: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.enum(["low", "normal", "high", "critical"]).optional().default("normal"),
    expires_at: z.string().datetime().optional(),
    merge_into: z
      .array(z.string())
      .min(1)
      .max(20)
      .optional()
      .describe("Replace these memories with this one; they are removed and kept in the audit log"),
    supersedes: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("Memories this one contradicts; they are removed and kept in the audit log"),
  })
  .openapi("CreateMemory");

const SimilarMemorySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  type: MemoryTypeSchema,
  snippet: z.string(),
  similarity: z.number(),
});

// The stored memory (or, on skip, the existing one kept) plus the dedup outcome beside it.
const StoreMemoryResultSchema = MemorySchema.extend({
  status: z.enum(["added", "merged", "skipped"]),
  existing_id: z.string().optional().describe("Set on skip: the near-identical memory kept"),
  merged: z.array(z.string()).optional().describe("Set on merge: the memories this one replaced"),
  similar: z.array(SimilarMemorySchema),
  superseded: z.array(z.string()),
  hint: z.string().optional(),
}).openapi("StoreMemoryResult");

const searchRoute = createRoute({
  method: "get",
  path: "/memories/search",
  tags: ["Memory"],
  summary: "Search memories (3-layer BM25: porter → trigram → fallback)",
  request: {
    query: z.object({
      q: z.string().min(1, "Search query cannot be empty"),
      scope: z.string().optional(),
      type: MemoryTypeSchema.optional(),
      project_id: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(50).optional().default(10),
    }),
  },
  responses: {
    200: {
      description: "Search results",
      content: {
        "application/json": {
          schema: z.object({ results: z.array(MemorySchema) }),
        },
      },
    },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/memories",
  tags: ["Memory"],
  summary: "List memories",
  request: {
    query: z.object({
      scope: z.string().optional(),
      type: MemoryTypeSchema.optional(),
      project_id: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: "Memory list",
      content: {
        "application/json": {
          schema: z.object({ memories: z.array(MemorySchema) }),
        },
      },
    },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/memories",
  tags: ["Memory"],
  summary: "Store a memory (skips near-duplicates, can merge or supersede)",
  request: { body: { content: { "application/json": { schema: CreateMemorySchema } } } },
  responses: {
    200: {
      description: "Created a merged replacement, or kept a near-duplicate",
      content: { "application/json": { schema: StoreMemoryResultSchema } },
    },
    201: {
      description: "Created",
      content: { "application/json": { schema: StoreMemoryResultSchema } },
    },
  },
});

const UpdateMemorySchema = z
  .object({
    content: z.string().min(1).max(2_000_000).optional(),
    title: z.string().optional(),
    type: MemoryTypeSchema.optional(),
    source: z.string().optional(),
    session_id: z.string().min(1).max(200).optional(),
    scope: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.enum(["low", "normal", "high", "critical"]).optional(),
    supersedes: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("Memories this one contradicts; they are removed and kept in the audit log"),
  })
  .openapi("UpdateMemory");

const updateRoute = createRoute({
  method: "patch",
  path: "/memories/{id}",
  tags: ["Memory"],
  summary: "Update a memory (partial)",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: UpdateMemorySchema } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: MemorySchema } },
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/memories/{id}",
  tags: ["Memory"],
  summary: "Delete memory",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: "Deleted" },
  },
});

type RawRow = {
  id: string;
  title: string | null;
  type: string;
  content: string;
  source: string | null;
  scope: string | null;
  project_id: string | null;
  tags: string | null;
  importance: string;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

function rawToDto(r: RawRow) {
  return {
    id: r.id,
    title: r.title ?? null,
    type: (r.type ?? "fact") as "fact" | "decision" | "event" | "rule" | "discovery",
    content: r.content,
    source: r.source,
    scope: r.scope,
    project_id: r.project_id ?? null,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : null,
    importance: r.importance as "low" | "normal" | "high" | "critical",
    expires_at: r.expires_at ? new Date(r.expires_at * 1000).toISOString() : null,
    created_at: new Date(r.created_at * 1000).toISOString(),
    updated_at: new Date(r.updated_at * 1000).toISOString(),
  };
}

function toDto(m: typeof memories.$inferSelect) {
  return {
    id: m.id,
    title: m.title ?? null,
    type: (m.type ?? "fact") as "fact" | "decision" | "event" | "rule" | "discovery",
    content: m.content,
    source: m.source ?? null,
    scope: m.scope ?? null,
    project_id: m.project_id ?? null,
    tags: m.tags ?? null,
    importance: m.importance,
    expires_at: m.expires_at?.toISOString() ?? null,
    created_at: m.created_at.toISOString(),
    updated_at: m.updated_at.toISOString(),
  };
}

const SELECT_COLS = `m.id, m.title, m.type, m.content, m.source, m.scope, m.project_id, m.tags,
  m.importance, m.expires_at, m.created_at, m.updated_at`;

app.openapi(searchRoute, async (c) => {
  const db = getDb();
  const { q, scope, type, project_id, limit } = c.req.valid("query");
  const sqlite = (db as unknown as { $client: Database }).$client;
  const safe = q.replace(/["]/g, " ").trim();

  const scopeClause = scope ? " AND m.scope = ?" : "";
  const typeClause = type ? " AND m.type = ?" : "";
  const projectClause = project_id ? " AND m.project_id = ?" : "";
  const filterParams: (string | number)[] = [
    ...(scope ? [scope] : []),
    ...(type ? [type] : []),
    ...(project_id ? [project_id] : []),
  ];

  let rows: RawRow[] = [];

  const tryFts = (table: string, expr: string): RawRow[] => {
    try {
      return sqlite
        .query(
          `SELECT ${SELECT_COLS} FROM ${table} f JOIN memories m ON m.id = f.id
           WHERE f.${table} MATCH ?${scopeClause}${typeClause}${projectClause}
           AND (m.expires_at IS NULL OR m.expires_at > unixepoch())
           ORDER BY bm25(${table}, 0, 1.0, 3.0, 1.5, 0) LIMIT ?`,
        )
        .all(expr, ...filterParams, limit) as RawRow[];
    } catch {
      return [];
    }
  };

  const words = safe.split(/\s+/).filter(Boolean);
  const andExpr = words.join(" AND ");
  const orExpr = words.join(" OR ");

  rows = tryFts("memories_fts", andExpr);
  if (rows.length === 0) rows = tryFts("memories_fts", orExpr);
  if (rows.length === 0) rows = tryFts("memories_fts_trigram", andExpr);
  if (rows.length === 0) rows = tryFts("memories_fts_trigram", orExpr);

  if (rows.length === 0) {
    const fallbackParams: (string | number)[] = [`%${safe.toLowerCase()}%`, ...filterParams, limit];
    rows = sqlite
      .query(
        `SELECT ${SELECT_COLS} FROM memories m
         WHERE m.content LIKE ?${scopeClause}${typeClause}${projectClause}
         AND (m.expires_at IS NULL OR m.expires_at > unixepoch())
         ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(...fallbackParams) as RawRow[];
  }

  return c.json({ results: rows.map(rawToDto) });
});

app.openapi(listRoute, async (c) => {
  const db = getDb();
  const { scope, type, project_id, limit } = c.req.valid("query");
  const sqlite = (db as unknown as { $client: Database }).$client;

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (scope) {
    conditions.push("scope = ?");
    params.push(scope);
  }
  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }
  if (project_id) {
    conditions.push("project_id = ?");
    params.push(project_id);
  }
  params.push(limit);

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = sqlite
    .query(`SELECT ${SELECT_COLS} FROM memories m ${where} ORDER BY m.created_at DESC LIMIT ?`)
    .all(...params) as RawRow[];

  return c.json({ memories: rows.map(rawToDto) });
});

app.openapi(createRoute_, async (c) => {
  const db = getDb();
  const body = c.req.valid("json");
  const result = new MemoryStore(getSqlite(db)).store({
    ...body,
    expires_at: body.expires_at ? new Date(body.expires_at) : undefined,
    actor: API_ACTOR,
  });
  const memoryId = result.status === "skipped" ? result.existing_id : result.id;
  const mem = await db.query.memories.findFirst({ where: eq(memories.id, memoryId) });
  if (!mem) throw new NotFoundError("Memory", memoryId);
  const similar = result.status === "merged" ? [] : result.similar;
  const response = {
    ...toDto(mem),
    status: result.status,
    similar,
    superseded: result.superseded,
    ...(result.status === "skipped" ? { existing_id: result.existing_id } : {}),
    ...(result.status === "merged" ? { merged: result.merged } : {}),
    ...(similar.length > 0 ? { hint: SIMILAR_MEMORY_HINT } : {}),
  };
  return c.json(response, result.status === "added" ? 201 : 200);
});

app.openapi(updateRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const store = new MemoryStore(getSqlite(db));
  const { supersedes, session_id, ...fields } = body;
  store.update(id, fields, { actor: API_ACTOR, session_id }, supersedes);
  const mem = await db.query.memories.findFirst({ where: eq(memories.id, id) });
  return c.json(toDto(mem as NonNullable<typeof mem>));
});

app.openapi(deleteRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  new MemoryStore(getSqlite(db)).remove(id, { actor: API_ACTOR });
  return new Response(null, { status: 204 });
});

export { app as memoriesRouter };
