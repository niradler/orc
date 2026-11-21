import { createRoute, z } from "@hono/zod-openapi";
import { NotFoundError } from "@orc/core/errors";
import { GoalSpecSchema } from "@orc/core/goal";
import { createGoal, getGoal, getTaskGoal, listGoals, stopGoal } from "@orc/runner/goal-service";
import { createRouter } from "../lib/router.js";

const app = createRouter();

const GoalRunStatusSchema = z
  .object({
    status: z.enum(["active", "passed", "halted", "stopped"]),
    iteration: z.number().int(),
    stage: z.number().int(),
    stall: z.number().int(),
    tokens_used: z.number(),
    last_check: z
      .object({
        exit: z.number().int().nullable(),
        metric: z.number().nullable(),
        output: z.string().nullable(),
      })
      .nullable(),
    halt_reason: z.string().nullable(),
    started_at: z.number().nullable(),
    ended_at: z.number().nullable(),
  })
  .openapi("GoalRunStatus");

const GoalSchema = z
  .object({
    id: z.string(),
    task_id: z.string(),
    flow_run_id: z.string().nullable(),
    objective: z.string(),
    spec: GoalSpecSchema,
    status: z.enum(["active", "stopped"]),
    run: GoalRunStatusSchema.nullable(),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .openapi("Goal");

const CheckVisitSchema = z
  .object({
    attempt: z.number().int(),
    retry: z.number().int(),
    outcome: z.string().nullable(),
    summary: z.string().nullable(),
    started_at: z.number().nullable(),
    ended_at: z.number().nullable(),
  })
  .openapi("GoalCheckVisit");

const params = z.object({ id: z.string() });

app.openapi(
  createRoute({
    method: "get",
    path: "/goals",
    tags: ["Goals"],
    summary: "List goals, newest first",
    responses: {
      200: {
        description: "Goals",
        content: { "application/json": { schema: z.object({ goals: z.array(GoalSchema) }) } },
      },
    },
  }),
  async (c) => c.json({ goals: await listGoals() }),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/goals/{id}",
    tags: ["Goals"],
    summary: "A goal with its live status and check history",
    request: { params },
    responses: {
      200: {
        description: "Goal",
        content: {
          "application/json": {
            schema: z.object({ goal: GoalSchema, history: z.array(CheckVisitSchema) }),
          },
        },
      },
    },
  }),
  async (c) => {
    const found = await getGoal(c.req.valid("param").id);
    if (!found) throw new NotFoundError("Goal", c.req.valid("param").id);
    return c.json(found);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/tasks/{id}/goal",
    tags: ["Goals"],
    summary: "The goal attached to a task, if any",
    request: { params },
    responses: {
      200: {
        description: "Goal or null",
        content: { "application/json": { schema: z.object({ goal: GoalSchema.nullable() }) } },
      },
    },
  }),
  async (c) => c.json({ goal: await getTaskGoal(c.req.valid("param").id) }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/goals",
    tags: ["Goals"],
    summary: "Start a goal: a flow that loops worker and check until the check passes",
    request: {
      body: { content: { "application/json": { schema: GoalSpecSchema } } },
    },
    responses: {
      201: {
        description: "Goal started",
        content: { "application/json": { schema: z.object({ goal: GoalSchema }) } },
      },
    },
  }),
  async (c) => c.json({ goal: await createGoal(c.req.valid("json")) }, 201),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/goals/{id}/stop",
    tags: ["Goals"],
    summary: "Stop a goal's flow and mark it stopped",
    request: { params },
    responses: {
      200: {
        description: "Goal stopped",
        content: { "application/json": { schema: z.object({ goal: GoalSchema }) } },
      },
    },
  }),
  async (c) => c.json({ goal: await stopGoal(c.req.valid("param").id) }),
);

export { app as goalsRouter };
