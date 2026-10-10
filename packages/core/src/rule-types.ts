import { z } from "zod";

const identity = z.string().trim().min(1).max(128);
const base = { id: identity, reason: z.string().trim().min(1).max(1000) };
export const RuleSchema = z.discriminatedUnion("kind", [
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
    if (p.rules.reduce((sum, r) => sum + (r.kind === "context" ? r.content.length : 0), 0) > 16000)
      ctx.addIssue({ code: "custom", message: "Policy context exceeds 16000 characters" });
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
    phase: z.enum(["session_start", "pre_tool", "post_tool", "session_end"]),
    tool: identity.optional(),
    input: z.record(z.string(), z.unknown()).default({}),
    failed: z.boolean().default(false),
  })
  .strict();
export type RulePolicy = z.infer<typeof RulePolicySchema>;
export type RuleEvent = z.infer<typeof RuleEventSchema>;
export type RuleDecision = {
  decision: "abstain" | "deny";
  reasons: { rule_id: string; reason: string }[];
  context: string[];
  jobs: { rule_id: string; job_id: string }[];
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
