import { z } from "zod";

export const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const NotificationTypeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9.-]*$/);
export const NotificationPathSchema = z
  .string()
  .max(2048)
  .refine(
    (path) =>
      path.startsWith("/") &&
      !path.startsWith("//") &&
      [...path].every((character) => character.charCodeAt(0) > 32 && character !== "\\"),
    "Notification links must stay inside ORC",
  );

export const NotificationInputSchema = z
  .object({
    type: NotificationTypeSchema,
    source_key: z.string().min(1).max(500),
    source_id: z.string().min(1).max(256),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(500).default(""),
    level: z.enum(["needs-you", "done"]),
    project_id: z.string().min(1).max(256).nullable().default(null),
    path: NotificationPathSchema,
    requires_action: z.boolean().default(false),
    created_at: z.number().int().nonnegative(),
    expires_at: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.expires_at > value.created_at, "Expiry must follow creation");

export const NotificationSchema = z.object({
  id: z.string(),
  type: NotificationTypeSchema,
  source_id: z.string(),
  title: z.string(),
  body: z.string(),
  level: z.enum(["needs-you", "done"]),
  project_id: z.string().nullable(),
  path: NotificationPathSchema,
  requires_action: z.boolean(),
  created_at: z.number(),
  expires_at: z.number(),
  read_at: z.number().nullable(),
  dismissed_at: z.number().nullable(),
});

export const NotificationPageSchema = z.object({
  notifications: z.array(NotificationSchema),
  unread: z.number().int(),
  has_more: z.boolean(),
});
export const NotificationUpdateSchema = z
  .object({
    read: z.boolean().optional(),
    dismissed: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.read !== undefined || value.dismissed !== undefined,
    "Supply read or dismissed",
  );

export type OrcNotification = z.infer<typeof NotificationSchema>;
export type NotificationInput = z.input<typeof NotificationInputSchema>;
export type NotificationPage = z.infer<typeof NotificationPageSchema>;
export type NotificationUpdate = z.infer<typeof NotificationUpdateSchema>;

export const NOTIFICATION_TYPES = [
  "human.request",
  "agent.question",
  "agent.approval",
  "agent.finished",
  "agent.failed",
  "job.finished",
  "job.failed",
] as const;
export const NotificationFilterSchema = z
  .object({
    enabled: z.boolean().default(false),
    types: z.array(NotificationTypeSchema).max(100).default([]),
    categories: z
      .array(z.enum(["human", "agent", "job"]))
      .max(3)
      .default([]),
    levels: z
      .array(z.enum(["needs-you", "done"]))
      .max(2)
      .default([]),
    outcomes: z
      .array(z.enum(["waiting", "success", "failure"]))
      .max(3)
      .default([]),
    include_unknown: z.boolean().default(false),
  })
  .strict();
export type NotificationFilter = z.infer<typeof NotificationFilterSchema>;
export const NotificationForwardingPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    base_url: z
      .string()
      .max(2048)
      .default("")
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return (
            ["https:", "http:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === "/"
          );
        } catch {
          return false;
        }
      }, "Use an HTTP(S) ORC origin without credentials, a path, query or fragment"),
  })
  .strict()
  .refine(
    (value) => !value.enabled || !!value.base_url,
    "Set the ORC URL before enabling forwarding",
  );
export type NotificationForwardingPolicy = z.infer<typeof NotificationForwardingPolicySchema>;

export function notificationMatches(
  event: Pick<OrcNotification, "type" | "level" | "project_id">,
  filter: NotificationFilter,
  projectIds: readonly string[],
): boolean {
  if (
    !filter.enabled ||
    (projectIds.length && (!event.project_id || !projectIds.includes(event.project_id)))
  )
    return false;
  const known = (NOTIFICATION_TYPES as readonly string[]).includes(event.type);
  if (!known && !filter.include_unknown) return false;
  const category = event.type.split(".")[0] ?? "";
  const outcome = event.type.endsWith(".failed")
    ? "failure"
    : event.type.endsWith(".finished")
      ? "success"
      : "waiting";
  return (
    (!filter.types.length || filter.types.includes(event.type)) &&
    (!filter.categories.length || filter.categories.some((value) => value === category)) &&
    (!filter.levels.length || filter.levels.includes(event.level)) &&
    (!filter.outcomes.length || (known && filter.outcomes.includes(outcome)))
  );
}

/** External delivery never copies user-authored titles, prompts, commands or tool output. */
export function notificationSummary(event: Pick<OrcNotification, "type" | "level">): string {
  switch (event.type) {
    case "human.request":
      return "An agent needs your response in ORC.";
    case "agent.question":
      return "An agent is waiting for your answer in ORC.";
    case "agent.approval":
      return "An agent is waiting for your approval in ORC.";
    case "agent.finished":
      return "An agent finished its reply in ORC.";
    case "agent.failed":
      return "An agent could not complete its turn in ORC.";
    case "job.finished":
      return "An ORC job completed successfully.";
    case "job.failed":
      return "An ORC job failed. Open ORC for details.";
    default:
      return event.level === "needs-you"
        ? "A new ORC notification needs you."
        : "You have a new ORC notification.";
  }
}

export const NotificationDeliverySchema = z.object({
  notification_id: z.string(),
  connection_id: z.string(),
  target_id: z.string(),
  status: z.enum(["pending", "sending", "delivered", "failed", "unknown", "skipped"]),
  attempts: z.number().int(),
  next_at: z.number(),
  error: z.string().nullable(),
  receipt_id: z.string().nullable(),
  created_at: z.number(),
  expires_at: z.number(),
});
export type NotificationDelivery = z.infer<typeof NotificationDeliverySchema>;
