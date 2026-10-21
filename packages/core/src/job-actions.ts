import { z } from "zod";

export const JobActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), command: z.string().trim().min(1) }).strict(),
  z
    .object({
      type: z.literal("agent"),
      prompt: z.string().trim().min(1).max(100000),
      backend: z.string().trim().min(1).max(64),
      model: z.string().trim().min(1).max(128).optional(),
      auto_approve: z.boolean().default(false),
    })
    .strict(),
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
