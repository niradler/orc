import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { decryptSecret, encryptSecret } from "@orc/core/secrets";
import { getDb, getSqlite } from "@orc/db/client";
import {
  job_runs,
  jobs,
  webhook_deliveries,
  webhook_delivery_runs,
  webhook_subscriptions,
  webhooks,
} from "@orc/db/schema";
import { withTx } from "@orc/db/tx";
import { executeJob } from "@orc/runner/executor";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { createRouter } from "../lib/router.js";

const logger = createLogger("api:webhooks");
const MAX_BYTES = 1_000_000;
const Provider = z.enum(["generic", "github"]);
const List = z.array(z.string().trim().min(1).max(128)).max(50);
const Webhook = z.object({
  id: z.string(),
  name: z.string(),
  provider: Provider,
  job_id: z.string().nullable(),
  project_id: z.string().nullable(),
  subscriptions: z.array(
    z.object({
      job_id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      events: List,
      actions: List,
    }),
  ),
  token: z.string(),
  events: List,
  actions: List,
  enabled: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
const Delivery = z.object({
  id: z.string(),
  webhook_id: z.string(),
  delivery_key: z.string(),
  event: z.string(),
  action: z.string().nullable(),
  repository: z.string().nullable(),
  payload_hash: z.string(),
  status: z.enum(["ignored", "running", "success", "failed"]),
  job_run_id: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  runs: z.array(
    z.object({
      job_id: z.string(),
      job_run_id: z.string(),
      status: z.string(),
      task_id: z.string().nullable(),
      session_id: z.string().nullable(),
    }),
  ),
});
const Create = z
  .object({
    name: z.string().trim().min(1).max(100),
    provider: Provider,
    job_id: z.string().min(1).max(128).optional(),
    project_id: z.string().min(1).max(128).nullable().optional(),
    events: List.default([]),
    actions: List.default([]),
    enabled: z.boolean().default(true),
  })
  .strict();
const Update = Create.partial().strict();
const secretValue = () => randomBytes(32).toString("base64url");
const tokenValue = () => randomBytes(18).toString("base64url");
const safe = (row: typeof webhooks.$inferSelect) => {
  const { secret: _secret, ...value } = row;
  const subscriptions = getSqlite()
    .query<
      { job_id: string; name: string; enabled: number; events: string; actions: string },
      [string]
    >(
      "SELECT s.job_id,j.name,j.enabled,s.events,s.actions FROM webhook_subscriptions s JOIN jobs j ON j.id=s.job_id WHERE s.webhook_id=?",
    )
    .all(row.id)
    .map((subscription) => ({
      ...subscription,
      enabled: Boolean(subscription.enabled),
      events: JSON.parse(subscription.events) as string[],
      actions: JSON.parse(subscription.actions) as string[],
    }));
  return { ...value, subscriptions };
};
function signature(secret: string, body: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}
function signatureMatches(expected: string, supplied?: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function requireJob(id: string, requireEnabled = false) {
  const job = await getDb().query.jobs.findFirst({ where: eq(jobs.id, id) });
  if (
    !job ||
    (requireEnabled && !job.enabled) ||
    job.command.startsWith("__internal:") ||
    job.command.startsWith("__orc_")
  )
    throw new ValidationError(
      requireEnabled
        ? "Webhook requires an enabled ordinary job"
        : "Webhook requires an ordinary job",
    );
  return job;
}

export function createWebhooksRouter() {
  const app = createRouter();
  app.openapi(
    createRoute({
      method: "get",
      path: "/webhooks",
      tags: ["Webhooks"],
      request: { query: z.object({ project_id: z.string().optional() }) },
      responses: {
        200: {
          description: "Webhooks",
          content: {
            "application/json": { schema: z.object({ webhooks: z.array(Webhook) }) },
          },
        },
      },
    }),
    async (c) => {
      const project = c.req.valid("query").project_id;
      const rows = await getDb()
        .select()
        .from(webhooks)
        .where(
          project ? or(eq(webhooks.project_id, project), isNull(webhooks.project_id)) : undefined,
        )
        .orderBy(desc(webhooks.created_at));
      return c.json({ webhooks: rows.map(safe) }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/webhooks",
      tags: ["Webhooks"],
      request: { body: { content: { "application/json": { schema: Create } } } },
      responses: {
        201: {
          description: "Secret is shown once",
          content: {
            "application/json": { schema: Webhook.extend({ secret: z.string() }) },
          },
        },
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const legacyJob = input.job_id ? await requireJob(input.job_id) : null;
      const projectId = input.project_id ?? legacyJob?.project_id ?? null;
      if (
        projectId &&
        !(await getDb().query.projects.findFirst({
          where: (table, { eq }) => eq(table.id, projectId),
        }))
      )
        throw new ValidationError("Project does not exist");
      if (legacyJob && projectId && legacyJob.project_id !== projectId)
        throw new ValidationError("Job belongs to another project");
      const secret = secretValue();
      const now = new Date();
      const row = {
        id: ulid(),
        name: input.name,
        provider: input.provider,
        job_id: null,
        project_id: projectId,
        token: tokenValue(),
        secret: encryptSecret(secret),
        events: [...new Set(input.events)],
        actions: [...new Set(input.actions)],
        enabled: input.enabled,
        created_at: now,
        updated_at: now,
      };
      withTx((tx) => {
        tx.insert(webhooks).values(row).run();
        if (legacyJob)
          tx.insert(webhook_subscriptions)
            .values({
              webhook_id: row.id,
              job_id: legacyJob.id,
              events: row.events,
              actions: row.actions,
            })
            .run();
      });
      return c.json({ ...safe(row), secret }, 201);
    },
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: "/webhooks/{id}",
      tags: ["Webhooks"],
      request: {
        params: z.object({ id: z.string() }),
        body: {
          content: { "application/json": { schema: Update } },
        },
      },
      responses: {
        200: { description: "Updated", content: { "application/json": { schema: Webhook } } },
      },
    }),
    async (c) => {
      const id = c.req.valid("param").id;
      const current = await getDb().query.webhooks.findFirst({ where: eq(webhooks.id, id) });
      if (!current) throw new NotFoundError("Webhook", id);
      const input = c.req.valid("json");
      if (input.job_id) throw new ValidationError("Connect jobs from the job configuration");
      if (input.project_id !== undefined && input.project_id !== current.project_id)
        throw new ValidationError("Project cannot change on an existing webhook");
      await getDb()
        .update(webhooks)
        .set({
          ...input,
          ...(input.events ? { events: [...new Set(input.events)] } : {}),
          ...(input.actions ? { actions: [...new Set(input.actions)] } : {}),
          updated_at: new Date(),
        })
        .where(eq(webhooks.id, id));
      const row = await getDb().query.webhooks.findFirst({ where: eq(webhooks.id, id) });
      return c.json(safe(row as typeof current), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/webhooks/{id}/rotate-secret",
      tags: ["Webhooks"],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Secret is shown once",
          content: {
            "application/json": { schema: z.object({ secret: z.string() }) },
          },
        },
      },
    }),
    async (c) => {
      const id = c.req.valid("param").id;
      if (!(await getDb().query.webhooks.findFirst({ where: eq(webhooks.id, id) })))
        throw new NotFoundError("Webhook", id);
      const secret = secretValue();
      await getDb()
        .update(webhooks)
        .set({ secret: encryptSecret(secret), updated_at: new Date() })
        .where(eq(webhooks.id, id));
      return c.json({ secret }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: "/webhooks/{id}",
      tags: ["Webhooks"],
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "Deleted" } },
    }),
    (c) => {
      const result = getSqlite()
        .query("DELETE FROM webhooks WHERE id=?")
        .run(c.req.valid("param").id);
      if (!result.changes) throw new NotFoundError("Webhook", c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/webhooks/{id}/deliveries",
      tags: ["Webhooks"],
      request: {
        params: z.object({ id: z.string() }),
        query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
      },
      responses: {
        200: {
          description: "Deliveries",
          content: {
            "application/json": { schema: z.object({ deliveries: z.array(Delivery) }) },
          },
        },
      },
    }),
    async (c) =>
      c.json(
        {
          deliveries: (
            await getDb().query.webhook_deliveries.findMany({
              where: eq(webhook_deliveries.webhook_id, c.req.valid("param").id),
              orderBy: [desc(webhook_deliveries.created_at)],
              limit: c.req.valid("query").limit,
            })
          ).map((delivery) => ({
            ...delivery,
            runs: getSqlite()
              .query<
                {
                  job_id: string;
                  job_run_id: string;
                  status: string;
                  task_id: string | null;
                  session_id: string | null;
                },
                [string]
              >(
                "SELECT d.job_id,d.job_run_id,r.status,r.task_id,r.session_id FROM webhook_delivery_runs d JOIN job_runs r ON r.id=d.job_run_id WHERE d.delivery_id=?",
              )
              .all(delivery.id),
          })),
        },
        200,
      ),
  );
  return app;
}

export function createWebhookPublicRouter() {
  const app = createRouter();
  app.use("/webhooks/*", bodyLimit({ maxSize: MAX_BYTES }));
  app.post("/webhooks/:token", async (c) => {
    const hook = await getDb().query.webhooks.findFirst({
      where: and(eq(webhooks.token, c.req.param("token")), eq(webhooks.enabled, true)),
    });
    if (!hook) throw new NotFoundError("Webhook", c.req.param("token"));
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const supplied =
      hook.provider === "github"
        ? c.req.header("x-hub-signature-256")
        : c.req.header("x-orc-signature-256");
    if (!signatureMatches(signature(decryptSecret(hook.secret), bytes), supplied))
      return c.json({ error: "Invalid webhook signature", code: "UNAUTHORIZED" }, 401);
    let payload: Record<string, unknown>;
    const text = new TextDecoder().decode(bytes);
    try {
      payload = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
    } catch {
      throw new ValidationError("Webhook payload must be a JSON object");
    }
    const event =
      hook.provider === "github"
        ? (c.req.header("x-github-event") ?? "")
        : (c.req.header("x-orc-event") ?? "delivery");
    if (!event || event.length > 128) throw new ValidationError("Webhook event is invalid");
    const action = typeof payload.action === "string" ? payload.action.slice(0, 128) : null;
    const repo = (payload.repository as { full_name?: unknown } | undefined)?.full_name;
    const repository = typeof repo === "string" ? repo.slice(0, 256) : null;
    const externalId =
      hook.provider === "github"
        ? c.req.header("x-github-delivery")
        : (c.req.header("x-orc-delivery") ?? c.req.header("idempotency-key"));
    if (hook.provider === "github" && !externalId)
      throw new ValidationError("X-GitHub-Delivery is required");
    const candidates = await getDb()
      .select({ job: jobs, subscription: webhook_subscriptions })
      .from(webhook_subscriptions)
      .innerJoin(jobs, eq(jobs.id, webhook_subscriptions.job_id))
      .where(and(eq(webhook_subscriptions.webhook_id, hook.id), eq(jobs.enabled, true)));
    const targets = candidates.filter(
      ({ job, subscription }) =>
        !job.command.startsWith("__internal:") &&
        !job.command.startsWith("__orc_") &&
        (!subscription.events.length || subscription.events.includes(event)) &&
        (!subscription.actions.length ||
          (action !== null && subscription.actions.includes(action))),
    );
    const accepted = targets.length > 0;
    const now = new Date();
    const delivery = {
      id: ulid(),
      webhook_id: hook.id,
      delivery_key: (externalId ?? ulid()).slice(0, 256),
      event,
      action,
      repository,
      payload_hash: createHash("sha256").update(bytes).digest("hex"),
      status: accepted ? ("running" as const) : ("ignored" as const),
      job_run_id: null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    const executions = targets.map((target) => ({ ...target, runId: ulid() }));
    const runIds = executions.map((target) => target.runId);
    try {
      withTx((tx) => {
        tx.insert(webhook_deliveries).values(delivery).run();
        for (const target of executions) {
          const runId = target.runId;
          tx.insert(job_runs)
            .values({
              id: runId,
              job_id: target.job.id,
              status: "pending",
              trigger_by: `webhook:${hook.id}`,
              created_at: now,
            })
            .run();
          tx.insert(webhook_delivery_runs)
            .values({ delivery_id: delivery.id, job_id: target.job.id, job_run_id: runId })
            .run();
        }
        if (accepted)
          tx.update(webhook_deliveries)
            .set({ job_run_id: runIds[0] })
            .where(eq(webhook_deliveries.id, delivery.id))
            .run();
      });
    } catch (error) {
      if (String(error).toLowerCase().includes("unique"))
        throw new ConflictError("Webhook delivery already received");
      throw error;
    }
    if (!accepted) return c.json({ accepted: false, delivery_id: delivery.id }, 202);
    void Promise.allSettled(
      executions.map((target) =>
        executeJob({
          jobId: target.job.id,
          runId: target.runId,
          triggerBy: `webhook:${hook.id}`,
          input: {
            stdin: text,
            env: {
              ORC_WEBHOOK_ID: hook.id,
              ORC_WEBHOOK_DELIVERY_ID: delivery.id,
              ORC_WEBHOOK_PROVIDER: hook.provider,
              ORC_WEBHOOK_EVENT: event,
              ORC_WEBHOOK_ACTION: action ?? "",
              ORC_WEBHOOK_REPOSITORY: repository ?? "",
            },
          },
        }),
      ),
    )
      .then(async (results) => {
        const runs = getSqlite()
          .query<{ status: string; error_msg: string | null }, [string]>(
            "SELECT r.status,r.error_msg FROM job_runs r JOIN webhook_delivery_runs d ON d.job_run_id=r.id WHERE d.delivery_id=?",
          )
          .all(delivery.id);
        const failed =
          results.some((result) => result.status === "rejected") ||
          runs.some((run) => run.status !== "success");
        await getDb()
          .update(webhook_deliveries)
          .set({
            status: failed ? "failed" : "success",
            error: failed
              ? runs
                  .map((run) => run.error_msg)
                  .filter(Boolean)
                  .join("; ")
                  .slice(0, 2000) || "One or more jobs failed"
              : null,
            updated_at: new Date(),
          })
          .where(eq(webhook_deliveries.id, delivery.id));
      })
      .catch((error) =>
        logger.error("Could not finish webhook delivery", {
          error: String(error),
          delivery_id: delivery.id,
        }),
      );
    return c.json(
      { accepted: true, delivery_id: delivery.id, run_id: runIds[0], run_ids: runIds },
      202,
    );
  });
  return app;
}

export const webhooksRouter = createWebhooksRouter();
export const webhookPublicRouter = createWebhookPublicRouter();
