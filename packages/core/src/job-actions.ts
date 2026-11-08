import { z } from "zod";
import { ChatAgentOptionsSchema } from "./chat-options.js";

export const JobActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), command: z.string().trim().min(1) }).strict(),
  z
    .object({
      type: z.literal("agent"),
      prompt: z.string().trim().min(1).max(100000),
      backend: z.string().trim().min(1).max(64),
      options: ChatAgentOptionsSchema.optional(),
      model: z.string().trim().min(1).max(128).optional(),
      auto_approve: z.boolean().default(false),
    })
    .strict()
    .superRefine((action, context) => {
      if (!action.options) return;
      if (["claude-cli", "a2a", "agentapi"].includes(action.backend))
        context.addIssue({
          code: "custom",
          path: ["options"],
          message:
            "This backend does not support job launch options. Choose Claude SDK, Codex CLI or ACPX.",
        });
      const runtime =
        action.backend === "claude"
          ? "claude-sdk"
          : action.backend === "codex-cli"
            ? "codex"
            : "acpx";
      if (action.options.runtime !== runtime)
        context.addIssue({
          code: "custom",
          path: ["options"],
          message: "Launch options do not match this backend",
        });
      if (
        !action.auto_approve &&
        ((action.options.runtime === "claude-sdk" &&
          ["acceptEdits", "bypassPermissions"].includes(
            action.options.options.permissionMode ?? "",
          )) ||
          (action.options.runtime === "acpx" &&
            action.options.args.some((argument) =>
              ["--approve-all", "--approve-reads"].includes(argument),
            )))
      )
        context.addIssue({
          code: "custom",
          path: ["options"],
          message: "Automatic tool approval must be enabled explicitly",
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
export const WebhookSubscriptionSchema = z
  .object({
    webhook_id: z.string().min(1).max(128),
    events: z.array(z.string().trim().min(1).max(128)).max(50).default([]),
    actions: z.array(z.string().trim().min(1).max(128)).max(50).default([]),
  })
  .strict();
export type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>;
