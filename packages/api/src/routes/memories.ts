import type { Database } from "bun:sqlite";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { NotFoundError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { getDb } from "@orc/db/client";
import { memories } from "@orc/db/schema";
import { eq } from "drizzle-orm";

const app = new OpenAPIHono();

const MemoryTypeSchema = z.enum(["fact", "decision", "event", "rule", "discovery"]);

const MemorySchema = z
  .object({
    id: z.string(),
    title: z.string().nullable(),
    type: MemoryTypeSchema,
    content: z.string(),
    source: z.string().nullable(),
    scope: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    importance: z.enum(["low", "normal", "high", "critical"]),
    expires_at: z.string().datetime().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("Memory");

const CreateMemorySchema = z
  .object({
    content: z.string().min(1),
    title: z.string().optional(),
    type: MemoryTypeSchema.optional().default("fact"),
    source: z.string().optional(),
    scope: z.string().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.enum(["low", "normal", "high", "critical"]).optional().default("normal"),
    expires_at: z.string().datetime().optional(),
  })
  .openapi("CreateMemory");

const searchRoute = createRoute({
  method: "get",
  path: "/memories/search",
  tags: ["Memory"],
  summary: "Search memories (3-layer BM25: porter → trigram → fallback)",
  request: {
    query: z.object({
      q: z.string().min(1),
      scope: z.string().optional(),
      type: MemoryTypeSchema.optional(),
      limit: z.coerce.number().int().min(1).max(50).optional().default(10),
    }),
  },
  responses: {
    200: {
      description: "Search results",
      content: { "application/json": { schema: z.object({ results: z.array(MemorySchema) }) } },
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
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: "Memory list",
      content: { "application/json": { schema: z.object({ memories: z.array(MemorySchema) }) } },
    },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/memories",
  tags: ["Memory"],
  summary: "Store a memory",
  request: { body: { content: { "application/json": { schema: CreateMemorySchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: MemorySchema } } },
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
    tags: m.tags ?? null,
    importance: m.importance,
    expires_at: m.expires_at?.toISOString() ?? null,
    created_at: m.created_at.toISOString(),
    updated_at: m.updated_at.toISOString(),
  };
}

const SELECT_COLS = `m.id, m.title, m.type, m.content, m.source, m.scope, m.tags,
  m.importance, m.expires_at, m.created_at, m.updated_at`;

app.openapi(searchRoute, async (c) => {
  const db = getDb();
  const { q, scope, type, limit } = c.req.valid("query");
  const sqlite = (db as unknown as { $client: Database }).$client;
  const safe = q.replace(/["]/g, " ").trim();

  const scopeClause = scope ? " AND m.scope = ?" : "";
  const typeClause = type ? " AND m.type = ?" : "";
  const filterParams: (string | number)[] = [...(scope ? [scope] : []), ...(type ? [type] : [])];

  let rows: RawRow[] = [];

  const tryFts = (table: string, expr: string): RawRow[] => {
    try {
      return sqlite
        .query(
          `SELECT ${SELECT_COLS} FROM ${table} f JOIN memories m ON m.id = f.id
           WHERE f.${table} MATCH ?${scopeClause}${typeClause} ORDER BY rank LIMIT ?`,
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
         WHERE m.content LIKE ?${scopeClause}${typeClause}
         ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(...fallbackParams) as RawRow[];
  }

  return c.json({ results: rows.map(rawToDto) });
});

app.openapi(listRoute, async (c) => {
  const db = getDb();
  const { scope, type, limit } = c.req.valid("query");
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
  const now = new Date();
  const id = ulid();

  await db.insert(memories).values({
    id,
    title: body.title,
    type: body.type ?? "fact",
    content: body.content,
    source: body.source,
    scope: body.scope,
    tags: body.tags,
    importance: body.importance,
    expires_at: body.expires_at ? new Date(body.expires_at) : undefined,
    created_at: now,
    updated_at: now,
  });

  const mem = await db.query.memories.findFirst({ where: eq(memories.id, id) });
  return c.json(toDto(mem as NonNullable<typeof mem>), 201);
});

app.openapi(deleteRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const existing = await db.query.memories.findFirst({ where: eq(memories.id, id) });
  if (!existing) throw new NotFoundError("Memory", id);
  await db.delete(memories).where(eq(memories.id, id));
  return new Response(null, { status: 204 });
});

export { app as memoriesRouter };
