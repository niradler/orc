import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { commitStaged, gitDiff, gitStatus, stageFiles } from "../git/panel.js";
import { worktreeDeps } from "../git/registry.js";
import { trackedWorktrees } from "../git/worktrees.js";
import {
  getTerminalManager,
  launchDeps,
  requireTerminals,
  sessionDirDeps,
} from "../terminals/service.js";
import { prepareSessionDirectory } from "../terminals/session-dir.js";
import { WorktreeSchema } from "./git.js";

const app = new OpenAPIHono();
const params = z.object({ id: z.string().min(1) });
function folder(id: string): string {
  requireTerminals(loadConfig());
  const cwd = getTerminalManager().get(id).cwd;
  if (!cwd) throw new ValidationError("Terminal has no working directory");
  return cwd;
}
const FileSchema = z.object({
  path: z.string(),
  index: z.string(),
  working: z.string(),
  original: z.string().nullable(),
});
app.openapi(
  createRoute({
    method: "get",
    path: "/terminals/{id}/git/status",
    tags: ["Git"],
    summary: "Git status for a terminal checkout",
    request: { params },
    responses: {
      200: {
        description: "Status",
        content: {
          "application/json": {
            schema: z.object({
              root: z.string().nullable(),
              branch: z.string().nullable(),
              files: z.array(FileSchema),
              branches: z.array(z.string()),
            }),
          },
        },
      },
    },
  }),
  async (c) => c.json(await gitStatus(folder(c.req.valid("param").id)), 200),
);
app.openapi(
  createRoute({
    method: "get",
    path: "/terminals/{id}/git/diff",
    tags: ["Git"],
    summary: "Read staged or working diff",
    request: {
      params,
      query: z.object({
        staged: z.enum(["0", "1"]).optional(),
        path: z.string().min(1).optional(),
      }),
    },
    responses: {
      200: {
        description: "Diff",
        content: {
          "application/json": { schema: z.object({ diff: z.string(), truncated: z.boolean() }) },
        },
      },
    },
  }),
  async (c) => {
    const cwd = folder(c.req.valid("param").id);
    const query = c.req.valid("query");
    if (query.path && !(await gitStatus(cwd)).files.some((file) => file.path === query.path))
      throw new ValidationError("Path is not in this checkout's status");
    return c.json(await gitDiff(cwd, query.staged === "1", query.path), 200);
  },
);
app.openapi(
  createRoute({
    method: "get",
    path: "/terminals/{id}/git/worktrees",
    tags: ["Git"],
    summary: "Read terminal worktrees",
    request: { params },
    responses: {
      200: {
        description: "Worktrees",
        content: {
          "application/json": {
            schema: z.object({ root: z.string().nullable(), worktrees: z.array(WorktreeSchema) }),
          },
        },
      },
    },
  }),
  async (c) => c.json(await trackedWorktrees(folder(c.req.valid("param").id), worktreeDeps()), 200),
);
app.openapi(
  createRoute({
    method: "post",
    path: "/terminals/{id}/git/stage",
    tags: ["Git"],
    summary: "Stage explicitly selected files",
    request: {
      params,
      body: {
        content: {
          "application/json": {
            schema: z.object({ paths: z.array(z.string().min(1)).min(1).max(100) }),
          },
        },
      },
    },
    responses: { 204: { description: "Staged" } },
  }),
  async (c) => {
    await stageFiles(folder(c.req.valid("param").id), c.req.valid("json").paths);
    return c.body(null, 204);
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/terminals/{id}/git/commit",
    tags: ["Git"],
    summary: "Commit currently staged changes",
    request: {
      params,
      body: {
        content: {
          "application/json": {
            schema: z.object({ message: z.string().trim().min(1).max(10_000) }),
          },
        },
      },
    },
    responses: { 204: { description: "Committed" } },
  }),
  async (c) => {
    await commitStaged(folder(c.req.valid("param").id), c.req.valid("json").message);
    return c.body(null, 204);
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/terminals/{id}/git/worktrees",
    tags: ["Git"],
    summary: "Create a new isolated orc worktree",
    request: { params },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: z.object({ path: z.string() }) } },
      },
    },
  }),
  async (c) => {
    const cwd = folder(c.req.valid("param").id);
    if (!(await gitStatus(cwd)).root) throw new ValidationError("Not a git repository");
    const deps = sessionDirDeps(launchDeps(loadConfig()));
    return c.json(
      { path: await prepareSessionDirectory({ cwd, worktree: true }, { ...deps, newId: ulid }) },
      201,
    );
  },
);

export { app as terminalGitRouter };
