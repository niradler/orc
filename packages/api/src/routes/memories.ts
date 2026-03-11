import type { Database } from "bun:sqlite";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { NotFoundError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { getDb } from "@orc/db/client";
import { memories } from "@orc/db/schema";
import { desc, eq } from "drizzle-orm";

const app = new OpenAPIHono();

const MemorySchema = z
  .object({
    id: z.string(),
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
  summary: "Search memories (BM25 full-text)",
  request: {
    query: z.object({
      q: z.string().min(1),
      scope: z.string().optional(),
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

function toDto(m: typeof memories.$inferSelect) {
  return {
    ...m,
    expires_at: m.expires_at?.toISOString() ?? null,
    created_at: m.created_at.toISOString(),
    updated_at: m.updated_at.toISOString(),
  };
}

app.openapi(searchRoute, async (c) => {
  const db = getDb();
  const { q, scope, limit } = c.req.valid("query");
  const sqlite = (db as unknown as { $client: Database }).$client;
  const safe = q.replace(/["]/g, " ").trim();

  type RawRow = {
    id: string;
    content: string;
    source: string | null;
    scope: string | null;
    tags: string | null;
    importance: string;
    expires_at: number | null;
    created_at: number;
    updated_at: number;
  };

  let rows: RawRow[] = [];
  try {
    const sql = scope
      ? `SELECT m.id, m.content, m.source, m.scope, m.tags, m.importance, m.expires_at, m.created_at, m.updated_at
         FROM memories_fts f JOIN memories m ON m.id = f.id
         WHERE f.memories_fts MATCH ? AND m.scope = ? ORDER BY rank LIMIT ?`
      : `SELECT m.id, m.content, m.source, m.scope, m.tags, m.importance, m.expires_at, m.created_at, m.updated_at
         FROM memories_fts f JOIN memories m ON m.id = f.id
         WHERE f.memories_fts MATCH ? ORDER BY rank LIMIT ?`;
    rows = scope
      ? (sqlite.query(sql).all(safe, scope, limit) as RawRow[])
      : (sqlite.query(sql).all(safe, limit) as RawRow[]);
  } catch {
    const fallbackSql = scope
      ? "SELECT * FROM memories WHERE content LIKE ? AND scope = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM memories WHERE content LIKE ? ORDER BY created_at DESC LIMIT ?";
    rows = scope
      ? (sqlite.query(fallbackSql).all(`%${q}%`, scope, limit) as RawRow[])
      : (sqlite.query(fallbackSql).all(`%${q}%`, limit) as RawRow[]);
  }

  const results = rows.map((r) => ({
    id: r.id,
    content: r.content,
    source: r.source,
    scope: r.scope,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : null,
    importance: r.importance as "low" | "normal" | "high" | "critical",
    expires_at: r.expires_at ? new Date(r.expires_at * 1000).toISOString() : null,
    created_at: new Date(r.created_at * 1000).toISOString(),
    updated_at: new Date(r.updated_at * 1000).toISOString(),
  }));

  return c.json({ results });
});

app.openapi(listRoute, async (c) => {
  const db = getDb();
  const { scope, limit } = c.req.valid("query");
  const rows = await db.query.memories.findMany({
    where: scope ? eq(memories.scope, scope) : undefined,
    limit,
    orderBy: [desc(memories.created_at)],
  });
  return c.json({ memories: rows.map(toDto) });
});

app.openapi(createRoute_, async (c) => {
  const db = getDb();
  const body = c.req.valid("json");
  const now = new Date();
  const id = ulid();

  await db.insert(memories).values({
    id,
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
  return c.json(toDto(mem!), 201);
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
