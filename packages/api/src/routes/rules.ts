import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { ForbiddenError } from "@orc/core/errors";
import { RuleEventSchema, RulePolicySchema } from "@orc/core/rules";
import { getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { bodyLimit } from "hono/body-limit";

const app = new OpenAPIHono();
app.use("/rules/*", bodyLimit({ maxSize: 1_200_000 }));
const ResultSchema = z.object({
  decision: z.enum(["abstain", "deny"]),
  reasons: z.array(z.object({ rule_id: z.string(), reason: z.string() })),
  context: z.array(z.string()),
  jobs: z.array(z.object({ rule_id: z.string(), job_id: z.string() })),
});
const RevisionSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  project_id: z.string().nullable(),
  policy: RulePolicySchema.nullable(),
  previous_id: z.string().nullable(),
  reason: z.string(),
  created_at: z.number(),
  current: z.boolean(),
});
const controls = (): RuleStore => {
  if (!loadConfig().api.secret)
    throw new ForbiddenError("Set ORC_API_SECRET before administering rule policies");
  return new RuleStore(getSqlite());
};
app.openapi(
  createRoute({
    method: "get",
    path: "/rules",
    tags: ["Rules"],
    request: { query: z.object({ workspace: z.string().optional() }) },
    responses: {
      200: {
        description: "Rule history and redacted decisions",
        content: {
          "application/json": {
            schema: z.object({
              enabled: z.boolean(),
              history: z.array(RevisionSchema),
              decisions: z.array(
                z.object({
                  id: z.string(),
                  revision_id: z.string(),
                  session_id: z.string(),
                  phase: z.string(),
                  tool: z.string().nullable(),
                  result: z.string(),
                  created_at: z.number(),
                }),
              ),
              actions: z.array(
                z.object({
                  id: z.string(),
                  job_id: z.string(),
                  status: z.string(),
                  run_id: z.string().nullable(),
                  error: z.string().nullable(),
                }),
              ),
              adapters: z.array(z.object({ backend: z.string(), interception: z.string() })),
            }),
          },
        },
      },
    },
  }),
  (c) => {
    const store = controls();
    const workspace = c.req.valid("query").workspace;
    return c.json(
      {
        enabled: loadConfig().rules.enabled,
        history: store.history(workspace),
        decisions: store.decisions(workspace),
        actions: store.actions(workspace),
        adapters: [
          { backend: "claude", interception: "sdk_pre_tool" },
          { backend: "cursor", interception: "native_hook_requires_install_and_conformance" },
          { backend: "gemini", interception: "native_hook_requires_install_and_conformance" },
          { backend: "other", interception: "unsupported" },
        ],
      },
      200,
    );
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/rules/activate",
    tags: ["Rules"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                policy: RulePolicySchema,
                expected_id: z.string().nullable(),
                reason: z.string().trim().min(1).max(4000),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      201: {
        description: "Immutable revision activated",
        content: { "application/json": { schema: RevisionSchema } },
      },
    },
  }),
  (c) => {
    const input = c.req.valid("json");
    return c.json(controls().activate(input.policy, input.expected_id, input.reason), 201);
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/rules/revert",
    tags: ["Rules"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({ id: z.string().min(1), reason: z.string().trim().min(1).max(4000) })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "New revision restores previous policy",
        content: { "application/json": { schema: RevisionSchema } },
      },
    },
  }),
  (c) => {
    const input = c.req.valid("json");
    return c.json(controls().revert(input.id, input.reason), 200);
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/rules/check",
    tags: ["Rules"],
    request: { body: { content: { "application/json": { schema: RuleEventSchema } } } },
    responses: {
      200: {
        description: "Dry run; no recorded decision or action",
        content: { "application/json": { schema: ResultSchema } },
      },
    },
  }),
  (c) => c.json(controls().evaluate(c.req.valid("json"), false), 200),
);

export { app as rulesRouter };
