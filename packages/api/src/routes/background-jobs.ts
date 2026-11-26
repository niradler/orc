import { createRoute, z } from "@hono/zod-openapi";
import {
  BackgroundJobRecordSchema,
  BackgroundJobStartSchema,
  BackgroundJobStatusSchema,
  getBackgroundJob,
  listBackgroundJobs,
  readBackgroundJobLog,
  startBackgroundJob,
  stopBackgroundJob,
} from "@orc/core/background-jobs";
import { NotFoundError, ValidationError } from "@orc/core/errors";
import { createRouter } from "../lib/router.js";

const app = createRouter();

const idParams = z.object({
  id: z.string().regex(/^[0-9A-Za-z_-]{4,64}$/),
});

const JobWithLogSchema = BackgroundJobRecordSchema.extend({
  log_tail: z.string().optional(),
  log_truncated: z.boolean().optional(),
  log_size_bytes: z.number().int().nonnegative().optional(),
});

app.openapi(
  createRoute({
    method: "post",
    path: "/background-jobs",
    tags: ["Background Jobs"],
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: BackgroundJobStartSchema,
          },
        },
      },
    },
    responses: {
      201: {
        description: "Detached background command started",
        content: { "application/json": { schema: BackgroundJobRecordSchema } },
      },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const sessionHeader = c.req.header("X-ORC-Session")?.trim();
    try {
      const job = startBackgroundJob({
        ...body,
        ...(body.session_id ? {} : sessionHeader ? { session_id: sessionHeader } : {}),
      });
      return c.json(job, 201);
    } catch (error) {
      throw new ValidationError(
        error instanceof Error ? error.message : "Could not start background job.",
      );
    }
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/background-jobs",
    tags: ["Background Jobs"],
    request: {
      query: z.object({
        session_id: z.string().optional(),
        project_id: z.string().optional(),
        status: BackgroundJobStatusSchema.optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: {
        description: "Detached background jobs",
        content: {
          "application/json": {
            schema: z.object({ jobs: z.array(BackgroundJobRecordSchema) }),
          },
        },
      },
    },
  }),
  async (c) => {
    const query = c.req.valid("query");
    const jobs = listBackgroundJobs({
      session_id: query.session_id,
      project_id: query.project_id,
      status: query.status,
      limit: query.limit,
    });
    return c.json({ jobs }, 200);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/background-jobs/{id}",
    tags: ["Background Jobs"],
    request: {
      params: idParams,
      query: z.object({
        logs: z
          .enum(["true", "false"])
          .optional()
          .transform((v) => v !== "false"),
        tail_lines: z.coerce.number().int().min(1).max(2000).optional(),
        tail_bytes: z.coerce.number().int().min(256).max(256_000).optional(),
      }),
    },
    responses: {
      200: {
        description: "Detached background job status and optional log tail",
        content: { "application/json": { schema: JobWithLogSchema } },
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const query = c.req.valid("query");
    const job = getBackgroundJob(id);
    if (!job) throw new NotFoundError("BackgroundJob", id);
    if (!query.logs) return c.json(job, 200);
    const log = readBackgroundJobLog(id, {
      tail_lines: query.tail_lines,
      tail_bytes: query.tail_bytes,
    });
    return c.json(
      {
        ...job,
        log_tail: log.text,
        log_truncated: log.truncated,
        log_size_bytes: log.size_bytes,
      },
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/background-jobs/{id}/stop",
    tags: ["Background Jobs"],
    request: {
      params: idParams,
    },
    responses: {
      200: {
        description: "Stopped detached background job",
        content: { "application/json": { schema: BackgroundJobRecordSchema } },
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const stopped = await stopBackgroundJob(id);
    if (!stopped) throw new NotFoundError("BackgroundJob", id);
    return c.json(stopped, 200);
  },
);

export { app as backgroundJobsRouter };
