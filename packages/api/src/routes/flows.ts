import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { parseFlowDefinition } from "@orc/core/flow";
import {
  createFlow,
  FlowConflictError,
  type FlowSource,
  FlowValidationError,
  listBrokenFlows,
  listFlows,
  readFlow,
} from "@orc/core/flow-service";
import { getDb } from "@orc/db/client";
import { tasks } from "@orc/db/schema";
import { eq } from "drizzle-orm";

const app = new OpenAPIHono();

const FlowMetaSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    source: z.enum(["builtin", "user", "project"]),
    path: z.string().nullable(),
    version: z.number().int(),
    entry: z.string(),
    node_count: z.number().int(),
    edge_count: z.number().int(),
    shadows: z.enum(["builtin", "user", "project"]).nullable(),
  })
  .openapi("FlowMeta");

const FlowFullSchema = FlowMetaSchema.extend({
  definition: z.record(z.string(), z.unknown()),
}).openapi("FlowFull");

const BrokenFlowSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    errors: z.array(z.string()),
  })
  .openapi("BrokenFlow");

const FlowNodeRunSchema = z
  .object({
    node_id: z.string(),
    node_kind: z.string(),
    attempt: z.number().int(),
    retry: z.number().int(),
    status: z.string(),
    outcome: z.string().nullable(),
    summary: z.string().nullable(),
    error: z.string().nullable(),
    gateway_session_id: z.string().nullable(),
    created_at: z.number().openapi({
      description:
        "When the visit was recorded. A queued or human-parked node has no started_at, so this is the only clock for how long it has been waiting.",
    }),
    started_at: z.number().nullable(),
    ended_at: z.number().nullable(),
  })
  .openapi("FlowNodeRun");

const FlowRunSchema = z
  .object({
    id: z.string(),
    task_id: z.string(),
    flow_name: z.string(),
    flow_source: z.string(),
    status: z.string(),
    halt_reason: z.string().nullable(),
    halt_description: z.string().nullable(),
    active: z.array(z.object({ nodeId: z.string(), attempt: z.number().int() })),
    visits: z.record(z.string(), z.number()),
    node_executions: z.number().int(),
    vars: z.record(z.string(), z.unknown()),
    started_at: z.number(),
    ended_at: z.number().nullable(),
    definition: z.record(z.string(), z.unknown()).nullable(),
    nodes: z.array(FlowNodeRunSchema),
  })
  .openapi("FlowRun");

const CreateFlowSchema = z
  .object({
    definition: z.record(z.string(), z.unknown()),
    overwrite: z.boolean().optional(),
    shadow_builtin: z
      .boolean()
      .optional()
      .openapi({ description: "Deliberately shadow a built-in flow of the same name" }),
  })
  .openapi("CreateFlow");

const ValidateFlowSchema = z
  .object({ definition: z.record(z.string(), z.unknown()) })
  .openapi("ValidateFlow");

const AttachFlowSchema = z
  .object({
    name: z.string().optional(),
    definition: z.record(z.string(), z.unknown()).nullable().optional(),
    start: z.boolean().optional(),
  })
  .openapi("AttachFlow");

const ResumeFlowSchema = z
  .object({
    outcome: z.string().min(1),
    summary: z.string().optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
    author: z.string().optional(),
  })
  .openapi("ResumeFlow");

// --- Routes ---

const listRoute = createRoute({
  method: "get",
  path: "/flows",
  tags: ["Flows"],
  summary: "List available flow graphs",
  request: {
    query: z.object({
      q: z.string().optional(),
      source: z.enum(["builtin", "user", "project"]).optional(),
      // Not z.coerce.boolean(): that turns "false" and "0" into true.
      reload: z
        .enum(["true", "false", "1", "0"])
        .optional()
        .transform((v) => v === "true" || v === "1"),
    }),
  },
  responses: {
    200: {
      description: "Flow list, plus any definitions that failed validation",
      content: {
        "application/json": {
          schema: z.object({
            flows: z.array(FlowMetaSchema),
            broken: z.array(BrokenFlowSchema),
            default_flow: z.string().openapi({
              description:
                "Flow a task with no flow_name runs (config agent_loop.default_flow). Clients cannot know this otherwise, and 'which flow will this task run' is unanswerable without it.",
            }),
          }),
        },
      },
    },
  },
});

const readRoute = createRoute({
  method: "get",
  path: "/flows/{name}",
  tags: ["Flows"],
  summary: "Read a flow definition",
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: { description: "Flow", content: { "application/json": { schema: FlowFullSchema } } },
    404: { description: "Flow not found" },
  },
});

const createFlowRoute = createRoute({
  method: "post",
  path: "/flows",
  tags: ["Flows"],
  summary: "Create a user flow",
  request: { body: { content: { "application/json": { schema: CreateFlowSchema } } } },
  responses: {
    201: {
      description: "Created flow",
      content: { "application/json": { schema: FlowFullSchema } },
    },
    400: { description: "Invalid definition" },
    409: { description: "Flow already exists" },
  },
});

const validateRoute = createRoute({
  method: "post",
  path: "/flows/validate",
  tags: ["Flows"],
  summary: "Validate a flow definition without saving it",
  request: { body: { content: { "application/json": { schema: ValidateFlowSchema } } } },
  responses: {
    200: {
      description: "Validation result",
      content: {
        "application/json": {
          schema: z.object({ valid: z.boolean(), errors: z.array(z.string()) }),
        },
      },
    },
  },
});

const getTaskFlowRoute = createRoute({
  method: "get",
  path: "/tasks/{id}/flow",
  tags: ["Flows"],
  summary: "Get a task's most recent flow run and its ledger",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Flow run", content: { "application/json": { schema: FlowRunSchema } } },
    404: { description: "No flow run for this task" },
  },
});

const attachRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/flow",
  tags: ["Flows"],
  summary: "Attach a named or inline flow to a task, optionally starting it",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: AttachFlowSchema } } },
  },
  responses: {
    200: {
      description: "Attached",
      content: {
        "application/json": {
          schema: z.object({
            attached: z.string(),
            started: z.boolean(),
            flow_run_id: z.string().nullable(),
            error: z.string().nullable(),
          }),
        },
      },
    },
    400: { description: "Invalid definition or nothing to attach" },
    404: { description: "Task or flow not found" },
  },
});

const resumeRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/flow/resume",
  tags: ["Flows"],
  summary: "Resolve a human node so the flow can continue",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: ResumeFlowSchema } } },
  },
  responses: {
    200: {
      description: "Resumed",
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), next_nodes: z.array(z.string()) }),
        },
      },
    },
    400: { description: "Nothing waiting, or the outcome is not routable" },
  },
});

const haltRoute = createRoute({
  method: "post",
  path: "/tasks/{id}/flow/halt",
  tags: ["Flows"],
  summary: "Stop a task's running flow and kill its live nodes",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: z.object({ reason: z.string().optional() }) } },
    },
  },
  responses: {
    200: {
      description: "Halt result",
      content: { "application/json": { schema: z.object({ halted: z.boolean() }) } },
    },
  },
});

// --- Handlers ---

app.openapi(listRoute, (c) => {
  const { q, source, reload } = c.req.valid("query");
  const flows = listFlows({ q, source: source as FlowSource | undefined, reload });
  return c.json({
    flows,
    broken: listBrokenFlows(),
    default_flow: loadConfig().agent_loop.default_flow,
  });
});

app.openapi(readRoute, (c) => {
  const { name } = c.req.valid("param");
  const flow = readFlow(name);
  if (!flow) throw new NotFoundError("Flow", name);
  return c.json({ ...flow, definition: flow.definition as Record<string, unknown> });
});

app.openapi(validateRoute, (c) => {
  const { definition } = c.req.valid("json");
  const parsed = parseFlowDefinition(definition);
  return c.json(parsed.ok ? { valid: true, errors: [] } : { valid: false, errors: parsed.errors });
});

app.openapi(createFlowRoute, (c) => {
  const { definition, overwrite, shadow_builtin } = c.req.valid("json");
  try {
    const flow = createFlow(definition, {
      overwrite: overwrite ?? false,
      shadowBuiltin: shadow_builtin ?? false,
    });
    return c.json({ ...flow, definition: flow.definition as Record<string, unknown> }, 201);
  } catch (err) {
    // Typed, not substring-matched: a definition whose text happens to contain
    // "already exists" is a validation error, not a conflict.
    if (err instanceof FlowConflictError) throw new ConflictError(err.message);
    if (err instanceof FlowValidationError) throw new ValidationError(err.message);
    throw err;
  }
});

app.openapi(getTaskFlowRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { getLatestFlowRunForTask } = await import("@orc/runner/flow-runner");
  const run = getLatestFlowRunForTask(id);
  if (!run) throw new NotFoundError("Flow run for task", id);
  return c.json({
    ...run,
    definition: (run.definition ?? null) as Record<string, unknown> | null,
  });
});

app.openapi(attachRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { name, definition, start } = c.req.valid("json");
  const db = getDb();

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!task) throw new NotFoundError("Task", id);
  if (!name && !definition) {
    throw new ValidationError("Pass either name or definition");
  }

  let attached: string;
  if (definition) {
    const parsed = parseFlowDefinition(definition);
    if (!parsed.ok) throw new ValidationError(`Invalid flow: ${parsed.errors.join("; ")}`);
    await db
      .update(tasks)
      .set({ flow_override: parsed.definition, flow_name: null, updated_at: new Date() })
      .where(eq(tasks.id, id));
    attached = parsed.definition.name;
  } else {
    const flowName = name as string;
    if (!readFlow(flowName)) throw new NotFoundError("Flow", flowName);
    await db
      .update(tasks)
      .set({ flow_name: flowName, flow_override: null, updated_at: new Date() })
      .where(eq(tasks.id, id));
    attached = flowName;
  }

  if (!start) return c.json({ attached, started: false, flow_run_id: null, error: null });

  if (["done", "cancelled"].includes(task.status)) {
    throw new ValidationError(
      `Task is ${task.status}; move it back to todo before starting a flow on it`,
    );
  }

  const { startFlowForTask } = await import("@orc/runner/flow-runner");
  const result = await startFlowForTask(id);
  return c.json({
    attached,
    started: result.ok,
    flow_run_id: result.ok ? result.flowRunId : null,
    error: result.ok ? null : result.error,
  });
});

app.openapi(resumeRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { outcome, summary, vars, author } = c.req.valid("json");
  const { resumeHumanNode } = await import("@orc/runner/flow-runner");
  const result = await resumeHumanNode({
    taskId: id,
    outcome,
    ...(summary !== undefined ? { summary } : {}),
    ...(vars !== undefined ? { vars } : {}),
    ...(author !== undefined ? { author } : {}),
  });
  if (!result.ok) throw new ValidationError(result.error);
  return c.json({ ok: true, next_nodes: result.nextNodes });
});

app.openapi(haltRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  const { haltFlowRunForTask } = await import("@orc/runner/flow-runner");
  const halted = await haltFlowRunForTask(id, reason ?? "halted via API", "human");
  return c.json({ halted });
});

export const flowsRouter = app;
