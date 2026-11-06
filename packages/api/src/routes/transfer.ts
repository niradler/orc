import { createRoute, z } from "@hono/zod-openapi";
import { ImportResultSchema, ProjectBundleSchema } from "@orc/core/project-bundle";
import { getDb, getSqlite } from "@orc/db/client";
import { exportProject, exportTask, importBundle } from "@orc/db/project-transfer";
import { jobs } from "@orc/db/schema";
import { syncJob } from "@orc/runner/scheduler";
import { eq } from "drizzle-orm";
import { createRouter } from "../lib/router.js";

const app = createRouter();

app.openapi(
  createRoute({
    method: "post",
    path: "/export",
    tags: ["Transfer"],
    summary: "Export a project, or one task, as a portable bundle with secrets removed",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                project: z.string().min(1).optional(),
                task: z.string().min(1).optional(),
              })
              .strict()
              .refine((input) => Boolean(input.project) !== Boolean(input.task), {
                message: "Provide either a project or a task",
              }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Bundle. Secrets are listed in needs_reentry and are not included.",
        content: { "application/json": { schema: ProjectBundleSchema } },
      },
      404: { description: "Project or task not found" },
    },
  }),
  (c) => {
    const input = c.req.valid("json");
    const bundle = input.task
      ? exportTask(getSqlite(), input.task)
      : exportProject(getSqlite(), input.project ?? "");
    return c.json(bundle);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/import",
    tags: ["Transfer"],
    summary: "Import a project bundle. Webhook secrets are issued again and returned once.",
    request: {
      body: { content: { "application/json": { schema: ProjectBundleSchema } } },
    },
    responses: {
      200: {
        description: "What was imported, what was skipped, and secrets that must be entered again",
        content: { "application/json": { schema: ImportResultSchema } },
      },
      400: { description: "Bundle is not valid" },
    },
  }),
  (c) => {
    const result = importBundle(getSqlite(), c.req.valid("json"), {
      onJob: (row) => {
        const id = typeof row.id === "string" ? row.id : "";
        const job = id ? getDb().select().from(jobs).where(eq(jobs.id, id)).get() : undefined;
        if (job) syncJob(job);
      },
    });
    return c.json(result);
  },
);

export const transferRouter = app;
