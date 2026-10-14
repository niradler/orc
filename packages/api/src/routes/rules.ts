import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { loadConfig } from "@orc/core/config";
import { RULE_CATALOG } from "@orc/core/rule-catalog";
import { RULE_EVENT_ADAPTERS } from "@orc/core/rule-events";
import {
  EventRuleSchema,
  RuleCommandProcessorSchema,
  RuleOrcActionSchema,
  RuleScriptSchema,
} from "@orc/core/rule-types";
import { RuleEventSchema, RulePolicySchema } from "@orc/core/rules";
import { getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { bodyLimit } from "hono/body-limit";
import { executeBuiltinRuleAction } from "../rule-builtins.js";

const app = new OpenAPIHono();
app.use("/rules/*", bodyLimit({ maxSize: 1_200_000 }));
const ResultSchema = z.object({
  orc_actions: z
    .array(
      z.object({
        rule_id: z.string(),
        revision_id: z.string().optional(),
        target: RuleOrcActionSchema,
      }),
    )
    .optional(),
  decision: z.enum(["abstain", "deny"]),
  reasons: z.array(z.object({ rule_id: z.string(), reason: z.string() })),
  context: z.array(z.string()),
  jobs: z.array(z.object({ rule_id: z.string(), job_id: z.string() })),
  scripts: z.array(z.object({ rule_id: z.string(), target: RuleScriptSchema })).optional(),
  command_processors: z
    .array(z.object({ rule_id: z.string(), target: RuleCommandProcessorSchema }))
    .optional(),
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
const controls = (): RuleStore => new RuleStore(getSqlite());
app.openapi(
  createRoute({
    method: "post",
    path: "/rules/actions/run",
    tags: ["Rules"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                event: RuleEventSchema,
                revision_id: z.string().min(1).max(128),
                rule_id: z.string().min(1).max(128),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Bounded built-in action for a matching active rule",
        content: {
          "application/json": {
            schema: z.object({ context: z.array(z.string().max(16000)), status: z.string() }),
          },
        },
      },
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    return c.json(
      await executeBuiltinRuleAction(input.event, input.revision_id, input.rule_id),
      200,
    );
  },
);
app.openapi(
  createRoute({
    method: "get",
    path: "/rules/catalog",
    tags: ["Rules"],
    responses: {
      200: {
        description: "Reusable starter rules; none are activated by loading",
        content: {
          "application/json": {
            schema: z.object({
              templates: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  description: z.string(),
                  category: z.string(),
                  configuration: z.string(),
                  rule: EventRuleSchema,
                }),
              ),
            }),
          },
        },
      },
    },
  }),
  (c) => c.json({ templates: [...RULE_CATALOG] }, 200),
);
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
              events: z.record(
                z.string(),
                z.array(
                  z.object({
                    native: z.string(),
                    event: z.string(),
                    block: z.boolean(),
                    context: z.boolean(),
                    rewrite_command: z.boolean(),
                  }),
                ),
              ),
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
        events: RULE_EVENT_ADAPTERS,
        adapters: [
          { backend: "claude", interception: "sdk_pre_tool" },
          {
            backend: "cursor",
            interception: "native_hook_requires_install_and_conformance",
          },
          {
            backend: "gemini",
            interception: "native_hook_requires_install_and_conformance",
          },
          {
            backend: "codex",
            interception: "native_hook_requires_install_trust_and_conformance",
          },
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
              .object({
                id: z.string().min(1),
                reason: z.string().trim().min(1).max(4000),
              })
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
    request: {
      body: { content: { "application/json": { schema: RuleEventSchema } } },
    },
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
