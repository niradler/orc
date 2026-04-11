import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getKnowledgeEngine } from "@orc/mcp/knowledge";

const app = new OpenAPIHono();

const KnowledgeSearchResultSchema = z
  .object({
    docid: z.string(),
    path: z.string(),
    collection: z.string(),
    title: z.string(),
    snippet: z.string(),
    score: z.number(),
  })
  .openapi("KnowledgeSearchResult");

const KnowledgeDocumentSchema = z
  .object({
    docid: z.string(),
    path: z.string(),
    collection: z.string(),
    title: z.string(),
    content: z.string(),
    modifiedAt: z.string(),
  })
  .openapi("KnowledgeDocument");

const KnowledgeCollectionSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    pattern: z.string(),
    documentCount: z.number(),
    lastModified: z.string().nullable(),
    projectId: z.string().nullable(),
  })
  .openapi("KnowledgeCollection");

const KnowledgeStatusSchema = z
  .object({
    collections: z.array(KnowledgeCollectionSchema),
    totalDocuments: z.number(),
    dbPath: z.string(),
    searchMode: z.string(),
  })
  .openapi("KnowledgeStatus");

// --- Search ---

const searchRoute = createRoute({
  method: "get",
  path: "/knowledge/search",
  tags: ["Knowledge"],
  summary: "Search knowledge documents (BM25 or hybrid)",
  request: {
    query: z.object({
      q: z.string().min(1),
      collection: z.string().optional(),
      project_id: z.string().optional(),
      mode: z.enum(["hybrid", "lexical"]).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional().default(10),
    }),
  },
  responses: {
    200: {
      description: "Search results",
      content: {
        "application/json": {
          schema: z.object({ results: z.array(KnowledgeSearchResultSchema) }),
        },
      },
    },
  },
});

app.openapi(searchRoute, async (c) => {
  const { q, collection, project_id, mode, limit } = c.req.valid("query");
  const engine = getKnowledgeEngine();
  const results = await engine.search(q, {
    ...(collection ? { collection } : {}),
    ...(project_id ? { project_id } : {}),
    ...(mode ? { mode } : {}),
    ...(limit != null ? { limit } : {}),
  });
  return c.json({ results });
});

// --- Get document ---

const getRoute = createRoute({
  method: "get",
  path: "/knowledge/documents/{id}",
  tags: ["Knowledge"],
  summary: "Get document by docid or path",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Document content",
      content: { "application/json": { schema: KnowledgeDocumentSchema } },
    },
    404: { description: "Not found" },
  },
});

app.openapi(getRoute, async (c) => {
  const { id } = c.req.valid("param");
  const engine = getKnowledgeEngine();
  const doc = await engine.get(id);
  if (!doc) return c.json({ error: "not_found", id }, 404);
  return c.json(doc);
});

// --- List collections ---

const listCollectionsRoute = createRoute({
  method: "get",
  path: "/knowledge/collections",
  tags: ["Knowledge"],
  summary: "List all knowledge collections",
  request: {
    query: z.object({
      project_id: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Collection list",
      content: {
        "application/json": {
          schema: z.object({ collections: z.array(KnowledgeCollectionSchema) }),
        },
      },
    },
  },
});

app.openapi(listCollectionsRoute, async (c) => {
  const { project_id } = c.req.valid("query");
  const engine = getKnowledgeEngine();
  const collections = await engine.listCollections(project_id ? { project_id } : {});
  return c.json({ collections });
});

// --- Add collection ---

const addCollectionRoute = createRoute({
  method: "post",
  path: "/knowledge/collections",
  tags: ["Knowledge"],
  summary: "Add a knowledge collection",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            path: z.string().min(1),
            pattern: z.string().optional().default("**/*.md"),
            project_id: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Collection added",
      content: {
        "application/json": {
          schema: z.object({ name: z.string(), indexed: z.number() }),
        },
      },
    },
  },
});

app.openapi(addCollectionRoute, async (c) => {
  const { name, path, pattern, project_id } = c.req.valid("json");
  const engine = getKnowledgeEngine();
  await engine.addCollection(name, {
    path,
    ...(pattern ? { pattern } : {}),
    ...(project_id ? { project_id } : {}),
  });
  const collections = await engine.listCollections();
  const added = collections.find((col) => col.name === name);
  return c.json({ name, indexed: added?.documentCount ?? 0 }, 201);
});

// --- Remove collection ---

const removeCollectionRoute = createRoute({
  method: "delete",
  path: "/knowledge/collections/{name}",
  tags: ["Knowledge"],
  summary: "Remove a knowledge collection",
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    204: { description: "Removed" },
    404: { description: "Not found" },
  },
});

app.openapi(removeCollectionRoute, async (c) => {
  const { name } = c.req.valid("param");
  const engine = getKnowledgeEngine();
  const removed = await engine.removeCollection(name);
  if (!removed) return c.json({ error: "not_found", name }, 404);
  return new Response(null, { status: 204 });
});

// --- Update (re-index) ---

const updateRoute = createRoute({
  method: "post",
  path: "/knowledge/update",
  tags: ["Knowledge"],
  summary: "Re-index knowledge collections",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            collections: z.array(z.string()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Re-index result",
      content: {
        "application/json": {
          schema: z.object({
            indexed: z.number(),
            updated: z.number(),
            removed: z.number(),
          }),
        },
      },
    },
  },
});

app.openapi(updateRoute, async (c) => {
  const { collections } = c.req.valid("json");
  const engine = getKnowledgeEngine();
  const result = await engine.update(collections ? { collections } : {});
  return c.json(result);
});

// --- Status ---

const statusRoute = createRoute({
  method: "get",
  path: "/knowledge/status",
  tags: ["Knowledge"],
  summary: "Knowledge store status",
  responses: {
    200: {
      description: "Status info",
      content: { "application/json": { schema: KnowledgeStatusSchema } },
    },
  },
});

app.openapi(statusRoute, async (c) => {
  const engine = getKnowledgeEngine();
  const status = await engine.getStatus();
  return c.json(status);
});

export { app as knowledgeRouter };
