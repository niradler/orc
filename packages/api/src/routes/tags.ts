import type { Database } from "bun:sqlite";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getDb } from "@orc/db/client";

const app = new OpenAPIHono();

const RESOURCE_TABLES: Record<string, string> = {
  task: "tasks",
  project: "projects",
  memory: "memories",
};

const listTagsRoute = createRoute({
  method: "get",
  path: "/tags",
  tags: ["Tags"],
  summary: "List unique tags across resources",
  request: {
    query: z.object({
      resource_type: z.enum(["task", "project", "memory"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "Unique tags with counts",
      content: {
        "application/json": {
          schema: z.object({
            tags: z.array(
              z.object({
                name: z.string(),
                count: z.number(),
                resource_type: z.string(),
              }),
            ),
          }),
        },
      },
    },
  },
});

function getSqlite(): Database {
  const db = getDb();
  return (db as unknown as { $client: Database }).$client;
}

app.openapi(listTagsRoute, async (c) => {
  const { resource_type } = c.req.valid("query");
  const sqlite = getSqlite();

  const tables = resource_type
    ? [[resource_type, RESOURCE_TABLES[resource_type] as string]]
    : Object.entries(RESOURCE_TABLES);

  const results: { name: string; count: number; resource_type: string }[] = [];

  for (const [type, table] of tables) {
    const rows = sqlite
      .query<{ tag: string; count: number }, []>(
        `SELECT j.value AS tag, COUNT(*) AS count
         FROM ${table}, json_each(${table}.tags) AS j
         WHERE ${table}.tags IS NOT NULL
         GROUP BY j.value
         ORDER BY count DESC, j.value ASC`,
      )
      .all();

    for (const row of rows) {
      results.push({ name: row.tag, count: row.count, resource_type: type as string });
    }
  }

  return c.json({ tags: results });
});

export { app as tagsRouter };
