import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { ValidationError } from "@orc/core/errors";
import { knownWorktrees, worktreeDeps } from "../git/registry.js";
import { isInside, listWorktrees, removeWorktree } from "../git/worktrees.js";
import { getTerminalManager, launchDeps, requireTerminals } from "../terminals/service.js";
import { runGit } from "../terminals/session-dir.js";

const app = new OpenAPIHono();

export const WorktreeSchema = z
  .object({
    path: z.string(),
    branch: z.string().nullable(),
    head: z.string().nullable(),
    main: z.boolean(),
    dirty: z.boolean(),
    detached: z.boolean(),
    locked: z.boolean(),
    prunable: z.boolean(),
    merged: z.boolean().optional(),
    upstream_gone: z.boolean().optional(),
    stale: z.boolean().optional(),
    active_terminal: z.string().nullable().optional(),
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
            delete_branch: z.boolean().optional(),
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
    {
      cwd: checkedFolder(body.cwd),
      path: body.path,
      force: body.force,
      delete_branch: body.delete_branch,
    },
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

const ListingSchema = z.object({ root: z.string().nullable(), worktrees: z.array(WorktreeSchema) });
app.openapi(
  createRoute({
    method: "get",
    path: "/git/registry",
    tags: ["Git"],
    summary: "Track worktrees across project scopes and recent terminals",
    request: { query: z.object({ project_id: z.string().optional() }) },
    responses: {
      200: {
        description: "Known repositories",
        content: {
          "application/json": {
            schema: z.object({
              repos: z.array(ListingSchema),
              errors: z.array(z.object({ cwd: z.string(), error: z.string() })),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    requireTerminals(loadConfig());
    return c.json(await knownWorktrees(c.req.valid("query").project_id), 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/git/worktrees/cleanup",
    tags: ["Git"],
    summary: "Safely clean selected merged or missing worktrees",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              items: z
                .array(
                  z.object({
                    cwd: z.string().min(1),
                    path: z.string().min(1),
                    delete_branch: z.boolean().optional(),
                  }),
                )
                .min(1)
                .max(100),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Per-worktree results",
        content: {
          "application/json": {
            schema: z.object({
              results: z.array(
                z.object({ path: z.string(), removed: z.boolean(), error: z.string().nullable() }),
              ),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    requireTerminals(loadConfig());
    const deps = worktreeDeps();
    const results: { path: string; removed: boolean; error: string | null }[] = [];
    for (const item of c.req.valid("json").items) {
      try {
        const { trackedWorktrees, samePath } = await import("../git/worktrees.js");
        const listing = await trackedWorktrees(checkedFolder(item.cwd), deps);
        const tree = listing.worktrees.find((tree) =>
          samePath(tree.path, item.path, process.platform),
        );
        if (
          !tree ||
          tree.main ||
          tree.dirty ||
          tree.locked ||
          tree.active_terminal ||
          (!tree.merged && !tree.prunable)
        )
          throw new ValidationError(
            "Only clean, inactive, unlocked merged or missing worktrees can be bulk cleaned",
          );
        await removeWorktree(item, deps);
        results.push({ path: item.path, removed: true, error: null });
      } catch (error) {
        results.push({
          path: item.path,
          removed: false,
          error: error instanceof Error ? error.message : "Cleanup failed",
        });
      }
    }
    return c.json({ results }, 200);
  },
);

export { app as gitRouter };
