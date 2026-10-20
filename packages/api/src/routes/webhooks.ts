import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { decryptSecret, encryptSecret } from "@orc/core/secrets";
import { getDb, getSqlite } from "@orc/db/client";
import { job_runs, jobs, webhook_deliveries, webhooks } from "@orc/db/schema";
import { executeJob } from "@orc/runner/executor";
import { and, desc, eq } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { createRouter } from "../lib/router.js";

const MAX_BYTES = 1_000_000;
const Provider = z.enum(["generic", "github"]);
const List = z.array(z.string().trim().min(1).max(128)).max(50);
const Webhook = z.object({
  id: z.string(),
  name: z.string(),
  provider: Provider,
  job_id: z.string(),
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
});
const Create = z
  .object({
    name: z.string().trim().min(1).max(100),
    provider: Provider,
    job_id: z.string().min(1).max(128),
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
  return value;
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
async function requireJob(id: string) {
  const job = await getDb().query.jobs.findFirst({ where: eq(jobs.id, id) });
  if (!job?.enabled || job.command.startsWith("__internal:"))
    throw new ValidationError("Webhook requires an enabled ordinary job");
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
        .select({ hook: webhooks })
        .from(webhooks)
        .innerJoin(jobs, eq(webhooks.job_id, jobs.id))
        .where(project ? eq(jobs.project_id, project) : undefined)
        .orderBy(desc(webhooks.created_at));
      return c.json({ webhooks: rows.map((row) => safe(row.hook)) }, 200);
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
      await requireJob(input.job_id);
      const secret = secretValue();
      const now = new Date();
      const row = {
        id: ulid(),
        name: input.name,
        provider: input.provider,
        job_id: input.job_id,
        token: tokenValue(),
        secret: encryptSecret(secret),
        events: [...new Set(input.events)],
        actions: [...new Set(input.actions)],
        enabled: input.enabled,
        created_at: now,
        updated_at: now,
      };
      await getDb().insert(webhooks).values(row);
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
      if (input.job_id) await requireJob(input.job_id);
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
          deliveries: await getDb().query.webhook_deliveries.findMany({
            where: eq(webhook_deliveries.webhook_id, c.req.valid("param").id),
            orderBy: [desc(webhook_deliveries.created_at)],
            limit: c.req.valid("query").limit,
          }),
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
    const accepted =
      (!hook.events.length || hook.events.includes(event)) &&
      (!hook.actions.length || (action !== null && hook.actions.includes(action)));
    if (accepted) await requireJob(hook.job_id);
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
    try {
      await getDb().insert(webhook_deliveries).values(delivery);
    } catch (error) {
      if (String(error).toLowerCase().includes("unique"))
        throw new ConflictError("Webhook delivery already received");
      throw error;
    }
    if (!accepted) return c.json({ accepted: false, delivery_id: delivery.id }, 202);
    const runId = ulid();
    await getDb()
      .insert(job_runs)
      .values({
        id: runId,
        job_id: hook.job_id,
        status: "pending",
        trigger_by: `webhook:${hook.id}`,
        created_at: now,
      });
    await getDb()
      .update(webhook_deliveries)
      .set({ job_run_id: runId })
      .where(eq(webhook_deliveries.id, delivery.id));
    void executeJob({
      jobId: hook.job_id,
      runId,
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
    })
      .then(async () => {
        const run = await getDb().query.job_runs.findFirst({ where: eq(job_runs.id, runId) });
        await getDb()
          .update(webhook_deliveries)
          .set({
            status: run?.status === "success" ? "success" : "failed",
            error: run?.error_msg ?? null,
            updated_at: new Date(),
          })
          .where(eq(webhook_deliveries.id, delivery.id));
      })
      .catch(async (error) => {
        await getDb()
          .update(webhook_deliveries)
          .set({
            status: "failed",
            error: String(error).slice(0, 2000),
            updated_at: new Date(),
          })
          .where(eq(webhook_deliveries.id, delivery.id));
      });
    return c.json({ accepted: true, delivery_id: delivery.id, run_id: runId }, 202);
  });
  return app;
}

export const webhooksRouter = createWebhooksRouter();
export const webhookPublicRouter = createWebhookPublicRouter();
