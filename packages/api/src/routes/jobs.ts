import { createRoute, z } from "@hono/zod-openapi";
import { NotFoundError, ValidationError } from "@orc/core/errors";
import { readFlow } from "@orc/core/flow-service";
import { ulid } from "@orc/core/ids";
import { JobActionSchema, WebhookSubscriptionSchema } from "@orc/core/job-actions";
import { createLogger } from "@orc/core/logger";
import { JobOverlapSchema, JobStatusSchema, JobTriggerTypeSchema } from "@orc/core/types";
import { getDb } from "@orc/db/client";
import { KB_DIGEST_COMMAND_PREFIX, kbDigestKbId } from "@orc/db/kb-digest";
import { job_run_logs, job_runs, jobs } from "@orc/db/schema";
import { deleteJob, withTx } from "@orc/db/tx";
import { executeJob } from "@orc/runner/executor";
import { syncJob, unscheduleJob } from "@orc/runner/scheduler";
import { Cron } from "croner";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { readJobWebhooks, saveJobWebhooks, validateJobWebhooks } from "../lib/job-webhooks.js";
import { createRouter } from "../lib/router.js";

const logger = createLogger("api:jobs");

const app = createRouter();

// Reject invalid cron expressions at write time instead of letting the scheduler
// throw later and leave a silently-broken job stored in the DB.
function assertValidCron(triggerType: string, cronExpr: string | undefined): void {
  if (triggerType !== "cron") return;
  if (!cronExpr) throw new ValidationError("cron_expr is required for cron trigger_type");
  try {
    new Cron(cronExpr, { paused: true }).stop();
  } catch {
    throw new ValidationError(`Invalid cron expression: ${cronExpr}`);
  }
}

// A knowledge base digest owns its job: the job page may pause it or change when it runs,
// everything else (instructions, backend, removal) is changed from the knowledge base.
const DIGEST_JOB_FIELDS = new Set(["enabled", "trigger_type", "cron_expr", "timeout_secs"]);

function assertNotDigestCommand(command: string | undefined): void {
  if (command?.startsWith(KB_DIGEST_COMMAND_PREFIX))
    throw new ValidationError("Digest jobs are created from a knowledge base's digest settings");
}

function assertDigestJobUpdate(command: string, body: Record<string, unknown>): void {
  if (!kbDigestKbId(command)) return;
  const other = Object.keys(body).filter((k) => body[k] !== undefined && !DIGEST_JOB_FIELDS.has(k));
  if (other.length)
    throw new ValidationError(
      `This job runs a knowledge base digest; change ${other.join(", ")} in the knowledge base's digest settings`,
    );
  if (
    body.trigger_type !== undefined &&
    body.trigger_type !== "cron" &&
    body.trigger_type !== "manual"
  )
    throw new ValidationError("A digest job runs on a cron schedule or manually");
}

const JobSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    command: z.string(),
    action: JobActionSchema,
    webhooks: z.array(WebhookSubscriptionSchema),
    trigger_type: JobTriggerTypeSchema,
    cron_expr: z.string().nullable(),
    enabled: z.boolean(),
    timeout_secs: z.number(),
    max_retries: z.number(),
    overlap: JobOverlapSchema,
    notify_on: z.enum(["never", "failure", "always"]),
    project_id: z.string().nullable(),
    run_count: z.number(),
    last_run_at: z.string().datetime().nullable(),
    next_run_at: z.string().datetime().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi("Job");

const CreateJobSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    command: z
      .string()
      .min(1)
      .describe("Shell command executed via `sh -c`. Runs with the server's privileges.")
      .optional(),
    action: JobActionSchema.optional(),
    webhooks: z.array(WebhookSubscriptionSchema).max(30).optional(),
    trigger_type: JobTriggerTypeSchema,
    cron_expr: z.string().optional(),
    enabled: z.boolean().default(false),
    watch_path: z.string().optional(),
    timeout_secs: z.number().int().positive().optional().default(300),
    max_retries: z.number().int().min(0).optional().default(0),
    overlap: JobOverlapSchema.optional().default("skip"),
    notify_on: z.enum(["never", "failure", "always"]).optional().default("failure"),
    env_vars: z.record(z.string(), z.string()).optional(),
    working_dir: z.string().optional(),
    project_id: z.string().optional(),
  })
  .openapi("CreateJob");

const JobRunSchema = z
  .object({
    id: z.string(),
    job_id: z.string(),
    task_id: z.string().nullable(),
    session_id: z.string().nullable(),
    status: JobStatusSchema,
    trigger_by: z.string().nullable(),
    started_at: z.string().datetime().nullable(),
    ended_at: z.string().datetime().nullable(),
    exit_code: z.number().nullable(),
    error_msg: z.string().nullable(),
    retry_num: z.number(),
    created_at: z.string().datetime(),
  })
  .openapi("JobRun");

const JobRunLogSchema = z
  .object({
    id: z.number(),
    run_id: z.string(),
    ts: z.string().datetime(),
    stream: z.enum(["stdout", "stderr"]),
    line: z.string(),
  })
  .openapi("JobRunLog");

const listRoute = createRoute({
  method: "get",
  path: "/jobs",
  tags: ["Jobs"],
  summary: "List jobs",
  request: {
    query: z.object({
      enabled: z
        .enum(["true", "false"])
        .transform((value) => value === "true")
        .optional(),
      project_id: z.string().optional().openapi({
        description: "Project id, or unassigned for jobs without a project; filtered before limit",
      }),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
      offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    }),
  },
  responses: {
    200: {
      description: "Jobs",
      content: {
        "application/json": {
          schema: z
            .object({
              jobs: z.array(JobSchema),
              offset: z.number().int(),
              limit: z.number().int(),
              next_offset: z.number().int().nullable(),
            })
            .openapi("JobPage"),
        },
      },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/jobs/{id}",
  tags: ["Jobs"],
  summary: "Get job",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Job",
      content: { "application/json": { schema: JobSchema } },
    },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/jobs",
  tags: ["Jobs"],
  summary: "Create job",
  request: {
    body: { content: { "application/json": { schema: CreateJobSchema } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: JobSchema } },
    },
  },
});

const UpdateJobSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
    command: z.string().min(1).optional(),
    action: JobActionSchema.optional(),
    webhooks: z.array(WebhookSubscriptionSchema).max(30).optional(),
    trigger_type: JobTriggerTypeSchema.optional(),
    cron_expr: z.string().optional(),
    watch_path: z.string().optional(),
    timeout_secs: z.number().int().positive().optional(),
    max_retries: z.number().int().min(0).optional(),
    overlap: JobOverlapSchema.optional(),
    notify_on: z.enum(["never", "failure", "always"]).optional(),
    enabled: z.boolean().optional(),
    env_vars: z.record(z.string(), z.string()).optional(),
    working_dir: z.string().optional(),
    project_id: z.string().optional(),
  })
  .openapi("UpdateJob");

const updateRoute = createRoute({
  method: "patch",
  path: "/jobs/{id}",
  tags: ["Jobs"],
  summary: "Update job",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: UpdateJobSchema } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: JobSchema } },
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/jobs/{id}",
  tags: ["Jobs"],
  summary: "Delete job",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: "Deleted" },
  },
});

const triggerRoute = createRoute({
  method: "post",
  path: "/jobs/{id}/trigger",
  tags: ["Jobs"],
  summary: "Manually trigger a job",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    202: {
      description: "Triggered",
      content: {
        "application/json": { schema: z.object({ run_id: z.string() }) },
      },
    },
  },
});

const runsRoute = createRoute({
  method: "get",
  path: "/jobs/{id}/runs",
  tags: ["Jobs"],
  summary: "List job runs",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: "Runs",
      content: {
        "application/json": {
          schema: z.object({ runs: z.array(JobRunSchema) }),
        },
      },
    },
  },
});

const runLogsRoute = createRoute({
  method: "get",
  path: "/jobs/{id}/runs/{runId}/logs",
  tags: ["Jobs"],
  summary: "Stream log lines for a specific run",
  request: {
    params: z.object({ id: z.string(), runId: z.string() }),
    query: z.object({
      stream: z.enum(["stdout", "stderr"]).optional(),
      limit: z.coerce.number().int().min(1).max(5000).optional().default(500),
    }),
  },
  responses: {
    200: {
      description: "Log lines",
      content: {
        "application/json": {
          schema: z.object({ logs: z.array(JobRunLogSchema) }),
        },
      },
    },
  },
});

function toDto(j: typeof jobs.$inferSelect) {
  return {
    ...j,
    action: j.action ?? { type: "command" as const, command: j.command },
    webhooks: readJobWebhooks(j.id),
    project_id: j.project_id ?? null,
    last_run_at: j.last_run_at?.toISOString() ?? null,
    next_run_at: j.next_run_at?.toISOString() ?? null,
    created_at: j.created_at.toISOString(),
    updated_at: j.updated_at.toISOString(),
  };
}

function runToDto(r: typeof job_runs.$inferSelect) {
  return {
    ...r,
    started_at: r.started_at?.toISOString() ?? null,
    ended_at: r.ended_at?.toISOString() ?? null,
    created_at: r.created_at.toISOString(),
  };
}

app.openapi(listRoute, async (c) => {
  const db = getDb();
  const { limit, offset, project_id, enabled } = c.req.valid("query");
  const conditions: ReturnType<typeof eq>[] = [];
  if (project_id === "unassigned") conditions.push(isNull(jobs.project_id));
  else if (project_id) conditions.push(eq(jobs.project_id, project_id));
  if (enabled !== undefined) conditions.push(eq(jobs.enabled, enabled));
  const rows = await db.query.jobs.findMany({
    where: conditions.length ? and(...conditions) : undefined,
    limit: limit + 1,
    offset,
    orderBy: (j, { asc }) => [asc(j.name), asc(j.id)],
  });
  return c.json({
    jobs: rows.slice(0, limit).map(toDto),
    offset,
    limit,
    next_offset: rows.length > limit ? offset + limit : null,
  });
});

app.openapi(getRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, id) });
  if (!job) throw new NotFoundError("Job", id);
  return c.json(toDto(job));
});

app.openapi(createRoute_, async (c) => {
  const db = getDb();
  const body = c.req.valid("json");
  assertValidCron(body.trigger_type, body.cron_expr);
  const action =
    body.action ?? (body.command ? { type: "command" as const, command: body.command } : null);
  if (!action) throw new ValidationError("Choose a job action");
  if (action.type === "task" && action.flow_name && !readFlow(action.flow_name))
    throw new ValidationError("Configured task flow does not exist");
  if (body.command && (action.type !== "command" || action.command !== body.command))
    throw new ValidationError("Command conflicts with action configuration");
  assertNotDigestCommand(action.type === "command" ? action.command : undefined);
  const bindings = body.webhooks ?? [];
  if (bindings.length && body.trigger_type !== "webhook")
    throw new ValidationError("Webhook connections require the webhook trigger");
  validateJobWebhooks(bindings, body.project_id ?? null);
  const now = new Date();
  const id = ulid();

  withTx((tx) => {
    tx.insert(jobs)
      .values({
        id,
        name: body.name,
        description: body.description,
        command: action.type === "command" ? action.command : "",
        action,
        trigger_type: body.trigger_type,
        enabled: body.enabled,
        cron_expr: body.cron_expr,
        watch_path: body.watch_path,
        timeout_secs: body.timeout_secs,
        max_retries: body.max_retries,
        overlap: body.overlap,
        notify_on: body.notify_on,
        env_vars: body.env_vars,
        working_dir: body.working_dir,
        project_id: body.project_id,
        created_at: now,
        updated_at: now,
      })
      .run();

    saveJobWebhooks(id, bindings);
  });

  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, id) });
  if (!job) throw new Error("Expected job to exist after write");
  syncJob(job);
  return c.json(toDto(job), 201);
});

app.openapi(updateRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const existing = await db.query.jobs.findFirst({ where: eq(jobs.id, id) });
  if (!existing) throw new NotFoundError("Job", id);
  assertDigestJobUpdate(existing.command, body);
  assertNotDigestCommand(body.command);

  const action =
    body.action ??
    (body.command
      ? { type: "command" as const, command: body.command }
      : (existing.action ?? { type: "command" as const, command: existing.command }));
  if (
    body.command &&
    body.action &&
    (body.action.type !== "command" || body.action.command !== body.command)
  )
    throw new ValidationError("Command conflicts with action configuration");
  if (body.action?.type === "command") assertNotDigestCommand(body.action.command);
  if (action.type === "task" && action.flow_name && !readFlow(action.flow_name))
    throw new ValidationError("Configured task flow does not exist");
  const bindings = body.webhooks ?? readJobWebhooks(id);
  validateJobWebhooks(bindings, body.project_id ?? existing.project_id ?? null);
  const effectiveTrigger = body.trigger_type ?? existing.trigger_type;
  const effectiveCron =
    body.cron_expr !== undefined ? body.cron_expr : (existing.cron_expr ?? undefined);
  assertValidCron(effectiveTrigger, effectiveCron);

  withTx((tx) => {
    tx.update(jobs)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.command !== undefined || body.action !== undefined
          ? { action, command: action.type === "command" ? action.command : "" }
          : {}),
        ...(body.trigger_type !== undefined ? { trigger_type: body.trigger_type } : {}),
        ...(body.cron_expr !== undefined ? { cron_expr: body.cron_expr } : {}),
        ...(body.watch_path !== undefined ? { watch_path: body.watch_path } : {}),
        ...(body.timeout_secs !== undefined ? { timeout_secs: body.timeout_secs } : {}),
        ...(body.max_retries !== undefined ? { max_retries: body.max_retries } : {}),
        ...(body.overlap !== undefined ? { overlap: body.overlap } : {}),
        ...(body.notify_on !== undefined ? { notify_on: body.notify_on } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.env_vars !== undefined ? { env_vars: body.env_vars } : {}),
        ...(body.working_dir !== undefined ? { working_dir: body.working_dir } : {}),
        ...(body.project_id !== undefined ? { project_id: body.project_id } : {}),
        updated_at: new Date(),
      })
      .where(eq(jobs.id, id))
      .run();

    if (body.webhooks !== undefined || body.trigger_type !== undefined)
      saveJobWebhooks(id, effectiveTrigger === "webhook" ? bindings : []);
  });

  const updated = await db.query.jobs.findFirst({ where: eq(jobs.id, id) });
  if (!updated) throw new Error("Expected job to exist after write");
  syncJob(updated);
  return c.json(toDto(updated));
});

app.openapi(deleteRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const existing = await db.query.jobs.findFirst({ where: eq(jobs.id, id) });
  if (!existing) throw new NotFoundError("Job", id);
  if (kbDigestKbId(existing.command))
    throw new ValidationError(
      "This job runs a knowledge base digest; remove the digest from the knowledge base instead",
    );
  deleteJob(id);
  unscheduleJob(id);
  return new Response(null, { status: 204 });
});

app.openapi(triggerRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, id) });
  if (!job) throw new NotFoundError("Job", id);

  const runId = ulid();
  await db.insert(job_runs).values({
    id: runId,
    job_id: id,
    status: "pending",
    trigger_by: "api",
    created_at: new Date(),
  });

  executeJob({ jobId: id, runId, triggerBy: "api" }).catch((err) =>
    logger.error(
      `Background execution failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );

  return c.json({ run_id: runId }, 202);
});

app.openapi(runsRoute, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const { limit } = c.req.valid("query");
  const rows = await db.query.job_runs.findMany({
    where: eq(job_runs.job_id, id),
    limit,
    orderBy: [desc(job_runs.created_at)],
  });
  return c.json({ runs: rows.map(runToDto) });
});

app.openapi(runLogsRoute, async (c) => {
  const db = getDb();
  const { id, runId } = c.req.valid("param");
  const { stream, limit } = c.req.valid("query");

  const run = await db.query.job_runs.findFirst({
    where: eq(job_runs.id, runId),
  });
  if (!run || run.job_id !== id) throw new NotFoundError("JobRun", runId);

  const rows = await db.query.job_run_logs.findMany({
    where: stream
      ? and(eq(job_run_logs.run_id, runId), eq(job_run_logs.stream, stream))
      : eq(job_run_logs.run_id, runId),
    limit,
    orderBy: [asc(job_run_logs.ts)],
  });

  return c.json({
    logs: rows.map((l) => ({ ...l, ts: l.ts.toISOString() })),
  });
});

export { app as jobsRouter };
