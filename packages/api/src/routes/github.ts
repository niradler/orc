import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { githubFeed } from "../git/github.js";
import { requireTerminals } from "../terminals/service.js";

export function createGithubRouter(readFeed: typeof githubFeed = githubFeed): OpenAPIHono {
  const app = new OpenAPIHono();
  const GithubItemSchema = z.object({
    repo: z.string(),
    number: z.number().int(),
    title: z.string(),
    url: z.string(),
    kind: z.enum(["issue", "pr"]),
    state: z.string(),
    branch: z.string().nullable(),
    assignees: z.array(z.string()),
    task_ids: z.array(z.string()),
  });
  app.openapi(
    createRoute({
      method: "get",
      path: "/github/items",
      tags: ["GitHub"],
      summary: "Read GitHub items relevant to known checkouts and task links",
      request: {
        query: z.object({
          project_id: z.string().optional(),
          filter: z
            .enum(["relevant", "assigned", "branches", "all"])
            .optional()
            .default("relevant"),
        }),
      },
      responses: {
        200: {
          description: "GitHub feed and auth status",
          content: {
            "application/json": {
              schema: z.object({
                auth: z.enum(["gh", "token", "none"]),
                login: z.string().nullable(),
                items: z.array(GithubItemSchema),
                errors: z.array(z.object({ repo: z.string(), error: z.string() })),
                truncated: z.boolean(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      requireTerminals(loadConfig());
      const query = c.req.valid("query");
      return c.json(await readFeed(query.project_id, query.filter), 200);
    },
  );

  return app;
}
export const githubRouter = createGithubRouter();
