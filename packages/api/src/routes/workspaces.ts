import { createRoute, z } from "@hono/zod-openapi";
import { getSqlite } from "@orc/db/client";
import { listWorkspaceEnvironments, workspaceEnvironmentByPath } from "@orc/db/workspaces";
import { createRouter } from "../lib/router.js";

const app = createRouter();

const WorkspaceSchema = z
  .object({
    worktree_path: z.string(),
    project_id: z.string().nullable(),
    repo_root: z.string().nullable(),
    git_branch: z.string().nullable(),
    host: z.string().nullable(),
    setup_status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
    setup_output: z.string().nullable(),
    setup_started_at: z.number().int().nullable(),
    setup_ended_at: z.number().int().nullable(),
    port_base: z.number().int().nullable(),
    port_count: z.number().int().nullable(),
    preview_url: z.string().nullable(),
    dev_terminal_id: z.string().nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .openapi("Workspace");

const listRoute = createRoute({
  method: "get",
  path: "/workspaces",
  tags: ["Workspaces"],
  summary: "List prepared workspaces with setup status, port block and preview URL",
  request: {
    query: z.object({
      project_id: z.string().optional(),
      path: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Workspaces",
      content: {
        "application/json": {
          schema: z.object({ workspaces: z.array(WorkspaceSchema) }).openapi("WorkspacePage"),
        },
      },
    },
  },
});

app.openapi(listRoute, (c) => {
  const { project_id, path } = c.req.valid("query");
  const sqlite = getSqlite();
  if (path) {
    const row = workspaceEnvironmentByPath(sqlite, path);
    return c.json({ workspaces: row ? [row] : [] }, 200);
  }
  return c.json({ workspaces: listWorkspaceEnvironments(sqlite, project_id) }, 200);
});

export { app as workspacesRouter };
