import { z } from "zod";
import { AgentRunSchema, optionsExceedPermissions, withAgentRunEffort } from "./agent-run.js";

export const JobActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), command: z.string().trim().min(1) }).strict(),
  z
    .object({
      type: z.literal("agent"),
      prompt: z.string().trim().min(1).max(100000),
      ...AgentRunSchema.shape,
    })
    .strict()
    .superRefine((action, context) => {
      if (action.effort && !withAgentRunEffort(action.agent, undefined, action.effort))
        context.addIssue({
          code: "custom",
          path: ["effort"],
          message: "This agent does not support a reasoning effort.",
        });
      if (["claude-cli", "a2a", "agentapi"].includes(action.agent)) {
        if (!action.options) return;
        context.addIssue({
          code: "custom",
          path: ["options"],
          message:
            "This agent does not support job launch options. Choose Claude SDK, Codex CLI or ACPX.",
        });
      }
      if (!action.options) return;
      const runtime =
        action.agent === "claude"
          ? "claude-sdk"
          : action.agent === "pi"
            ? "pi"
            : action.agent === "codex-cli"
              ? "codex"
              : action.agent === "opencode"
                ? "opencode"
                : "acpx";
      if (action.options.runtime !== runtime)
        context.addIssue({
          code: "custom",
          path: ["options"],
          message: "Launch options do not match this agent",
        });
      if (optionsExceedPermissions(action.options, action.permissions))
        context.addIssue({
          code: "custom",
          path: ["options"],
          message: "Launch options approve more than the chosen permissions allow",
        });
    }),
  z
    .object({
      type: z.literal("task"),
      title: z.string().trim().min(1).max(200),
      body: z.string().max(100000).default(""),
      start_automatically: z.boolean().default(false),
      flow_name: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
]);
export type JobAction = z.infer<typeof JobActionSchema>;

export function upgradeJobAction(raw: unknown): JobAction | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.type !== "agent" || !("backend" in record || "auto_approve" in record))
    return raw as JobAction;
  const { backend, auto_approve, ...rest } = record;
  return {
    ...rest,
    agent: rest.agent ?? backend,
    permissions: rest.permissions ?? (auto_approve === true ? "auto" : "ask"),
  } as JobAction;
}
export const WebhookSubscriptionSchema = z
  .object({
    webhook_id: z.string().min(1).max(128),
    events: z.array(z.string().trim().min(1).max(128)).max(50).default([]),
    actions: z.array(z.string().trim().min(1).max(128)).max(50).default([]),
  })
  .strict();
export type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>;
