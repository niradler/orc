import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { ValidationError } from "@orc/core/errors";
import { isInside, listWorktrees, removeWorktree } from "../git/worktrees.js";
import { getTerminalManager, launchDeps, requireTerminals } from "../terminals/service.js";
import { runGit } from "../terminals/session-dir.js";

const app = new OpenAPIHono();

const WorktreeSchema = z
  .object({
    path: z.string(),
    branch: z.string().nullable(),
    head: z.string().nullable(),
    main: z.boolean(),
    dirty: z.boolean(),
    detached: z.boolean(),
    locked: z.boolean(),
    prunable: z.boolean(),
  })
  .openapi("Worktree");

const listRoute = createRoute({
  method: "get",
  path: "/git/worktrees",
  tags: ["Git"],
  summary: "List the checkouts of the git repo that contains a folder",
  request: { query: z.object({ cwd: z.string().min(1) }) },
  responses: {
    200: {
      description: "Worktrees; root is null when the folder is not in a git repo",
      content: {
        "application/json": {
          schema: z.object({ root: z.string().nullable(), worktrees: z.array(WorktreeSchema) }),
        },
      },
    },
  },
});

const removeRoute = createRoute({
  method: "post",
  path: "/git/worktrees/remove",
  tags: ["Git"],
  summary: "Remove a linked worktree of the repo that contains cwd",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            cwd: z.string().min(1),
            path: z.string().min(1),
            force: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    204: { description: "Removed" },
  },
});

// These run git in folders on the API machine, so they sit behind the same gate as terminals.
function checkedFolder(cwd: string): string {
  const deps = launchDeps(loadConfig());
  if (!deps.isDirectory(cwd)) throw new ValidationError(`Not a directory: ${cwd}`);
  return cwd;
}

app.openapi(listRoute, async (c) => {
  requireTerminals(loadConfig());
  const cwd = checkedFolder(c.req.valid("query").cwd);
  return c.json(await listWorktrees(cwd, { runGit, platform: process.platform }), 200);
});

app.openapi(removeRoute, async (c) => {
  requireTerminals(loadConfig());
  const body = c.req.valid("json");
  await removeWorktree(
    { cwd: checkedFolder(body.cwd), path: body.path, force: body.force },
    {
      runGit,
      platform: process.platform,
      terminalUsing: (path) =>
        getTerminalManager()
          .list()
          .find((t) => t.status === "running" && t.cwd && isInside(t.cwd, path, process.platform))
          ?.name ?? null,
    },
  );
  return c.body(null, 204);
});

export { app as gitRouter };
