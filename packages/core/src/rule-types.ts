import { z } from "zod";
import { RULE_EVENT_ADAPTERS, ruleEventCapability } from "./rule-events.js";
import { RuleFilterSchema } from "./rule-filters.js";

const identity = z.string().trim().min(1).max(128);
const base = { id: identity, reason: z.string().trim().min(1).max(1000) };
export const RuleScriptSchema = z
  .object({
    type: z.literal("script"),
    mode: z.enum(["sync", "background"]),
    argv: z
      .array(
        z
          .string()
          .min(1)
          .max(4096)
          .refine((s) => !s.includes("\0")),
      )
      .min(1)
      .max(32),
    timeout_ms: z.number().int().min(100).max(30000),
  })
  .strict();
export const EventRuleSchema = z
  .object({
    ...base,
    kind: z.literal("event"),
    enabled: z.boolean(),
    scope: z
      .object({
        agents: z.union([
          z.literal("all"),
          z
            .array(z.enum(["claude", "cursor", "gemini", "codex"]))
            .min(1)
            .max(4),
        ]),
        events: z.array(identity).min(1).max(40),
      })
      .strict(),
    filter: RuleFilterSchema,
    target: z.discriminatedUnion("type", [
      z.object({ type: z.literal("block") }).strict(),
      z
        .object({ type: z.literal("inject_context"), content: z.string().min(1).max(8000) })
        .strict(),
      z.object({ type: z.literal("job"), job_id: identity }).strict(),
      RuleScriptSchema,
    ]),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const agents =
      rule.scope.agents === "all" ? Object.keys(RULE_EVENT_ADAPTERS) : rule.scope.agents;
    for (const event of rule.scope.events) {
      const capabilities = agents.map((agent) => ruleEventCapability(agent, event));
      if (!capabilities.some(Boolean))
        ctx.addIssue({ code: "custom", message: `No selected agent supports event ${event}` });
      if (event.startsWith("native:") && rule.scope.agents === "all")
        ctx.addIssue({ code: "custom", message: "Native events require specific agents" });
      if (rule.target.type === "block" && capabilities.some((entry) => entry && !entry.block))
        ctx.addIssue({
          code: "custom",
          message: `Event ${event} cannot block on every supporting selected agent`,
        });
      if (
        rule.target.type === "inject_context" &&
        capabilities.some((entry) => entry && !entry.context)
      )
        ctx.addIssue({
          code: "custom",
          message: `Event ${event} cannot inject context on every supporting selected agent`,
        });
    }
    if (
      rule.target.type === "script" &&
      rule.target.mode === "sync" &&
      rule.target.timeout_ms > 2000
    )
      ctx.addIssue({ code: "custom", message: "Synchronous script timeout cannot exceed 2000ms" });
  });
export const RuleSchema = z.discriminatedUnion("kind", [
  EventRuleSchema,
  z
    .object({ ...base, kind: z.literal("deny_tools"), tools: z.array(identity).min(1).max(100) })
    .strict(),
  z.object({ ...base, kind: z.literal("deny_delete") }).strict(),
  z.object({ ...base, kind: z.literal("deny_comments") }).strict(),
  z.object({ ...base, kind: z.literal("context"), content: z.string().min(1).max(8000) }).strict(),
  z
    .object({
      ...base,
      kind: z.literal("enqueue_job"),
      event: z.enum(["session_start", "post_tool", "session_end"]),
      tools: z.array(identity).max(100),
      job_id: identity,
    })
    .strict(),
]);
export const RulePolicySchema = z
  .object({
    workspace: z
      .string()
      .min(1)
      .max(4096)
      .refine((p) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p), "Workspace must be absolute"),
    project_id: identity.nullable(),
    rules: z.array(RuleSchema).min(1).max(100),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (new Set(p.rules.map((r) => r.id)).size !== p.rules.length)
      ctx.addIssue({ code: "custom", message: "Rule IDs must be unique" });
    if (
      p.rules.reduce(
        (sum, r) =>
          sum +
          (r.kind === "context"
            ? r.content.length
            : r.kind === "event" && r.target.type === "inject_context"
              ? r.target.content.length
              : 0),
        0,
      ) > 16000
    )
      ctx.addIssue({ code: "custom", message: "Policy context exceeds 16000 characters" });
    if (
      p.rules.reduce(
        (sum, r) =>
          sum +
          (r.kind === "event" && r.target.type === "script" && r.target.mode === "sync"
            ? r.target.timeout_ms
            : 0),
        0,
      ) > 5000
    )
      ctx.addIssue({ code: "custom", message: "Total synchronous script timeout exceeds 5000ms" });
  });
export const RuleEventSchema = z
  .object({
    id: identity,
    session_id: identity,
    backend: identity,
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .refine((p) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p)),
    phase: identity,
    native_event: identity.optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    tool: identity.optional(),
    input: z.record(z.string(), z.unknown()).default({}),
    failed: z.boolean().default(false),
  })
  .strict();
export type RulePolicy = z.infer<typeof RulePolicySchema>;
export type RuleEvent = z.infer<typeof RuleEventSchema>;
export type EventRule = z.infer<typeof EventRuleSchema>;
export type RuleScript = z.infer<typeof RuleScriptSchema>;
export type RuleDecision = {
  decision: "abstain" | "deny";
  reasons: { rule_id: string; reason: string }[];
  context: string[];
  jobs: { rule_id: string; job_id: string }[];
  scripts?: { rule_id: string; target: RuleScript }[];
};

export type RuleRevision = {
  id: string;
  workspace: string;
  project_id: string | null;
  policy: RulePolicy | null;
  previous_id: string | null;
  reason: string;
  created_at: number;
  current: boolean;
};
