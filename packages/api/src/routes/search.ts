import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getSqlite } from "@orc/db/client";

const app = new OpenAPIHono();
const Hit = z.object({
  kind: z.enum(["task", "project", "job", "memory", "session", "wiki"]),
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
});

// Identifiers and expressions come only from this allowlist; user text is bound.
const sources = [
  {
    kind: "task",
    table: "tasks",
    id: "r.id",
    title: "r.title",
    detail: "r.body",
    project: "r.project_id",
  },
  {
    kind: "project",
    table: "projects",
    id: "r.id",
    title: "r.name",
    detail: "r.description",
    project: "r.id",
  },
  {
    kind: "job",
    table: "jobs",
    id: "r.id",
    title: "r.name",
    detail: "r.description",
    project: "r.project_id",
  },
  {
    kind: "memory",
    table: "memories",
    id: "r.id",
    title: "coalesce(r.title, substr(r.content, 1, 100))",
    detail: "r.content",
    project: "r.project_id",
  },
  {
    kind: "session",
    table: "sessions",
    id: "r.id",
    title: "coalesce(nullif(r.summary, ''), r.agent)",
    detail: "r.summary",
    project: "r.project_id",
  },
  {
    kind: "wiki",
    table: "wiki_pages",
    id: "r.slug",
    title: "r.title",
    detail: "r.summary || ' ' || r.content",
    project: "r.project_id",
  },
] as const;

app.openapi(
  createRoute({
    method: "get",
    path: "/search",
    tags: ["Search"],
    summary: "Search all projects and stored resources for the command palette",
    request: {
      query: z.object({
        q: z.string().trim().min(1).max(200),
        project_id: z.string().min(1).max(100).optional(),
        limit: z.coerce.number().int().min(1).max(20).default(8),
      }),
    },
    responses: {
      200: {
        description: "Bounded results per resource type",
        content: { "application/json": { schema: z.object({ results: z.array(Hit) }) } },
      },
    },
  }),
  (c) => {
    const { q, project_id, limit } = c.req.valid("query");
    const db = getSqlite();
    const needle = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const results: z.infer<typeof Hit>[] = [];
    for (const source of sources) {
      const scope =
        project_id === "unassigned"
          ? `AND ${source.project} IS NULL`
          : project_id
            ? `AND ${source.project} = ?`
            : "";
      const rows = db
        .query<Omit<z.infer<typeof Hit>, "kind">, (string | number)[]>(`
        SELECT ${source.id} AS id, substr(${source.title}, 1, 160) AS title,
          substr(coalesce(${source.detail}, ''), 1, 180) AS detail,
          ${source.project} AS project_id, p.name AS project_name
        FROM ${source.table} r LEFT JOIN projects p ON p.id = ${source.project}
        WHERE (${source.title} LIKE ? ESCAPE '\\' OR ${source.detail} LIKE ? ESCAPE '\\'
          OR ${source.id} LIKE ? ESCAPE '\\') ${scope}
        ORDER BY CASE WHEN lower(${source.title}) = lower(?) THEN 0
          WHEN ${source.title} LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, ${source.id}
        LIMIT ?
      `)
        .all(
          needle,
          needle,
          needle,
          ...(project_id && project_id !== "unassigned" ? [project_id] : []),
          q,
          `${needle.slice(1)}`,
          limit,
        );
      results.push(...rows.map((row) => ({ ...row, kind: source.kind })));
    }
    c.header("Cache-Control", "no-store");
    return c.json({ results });
  },
);

export { app as searchRouter };
