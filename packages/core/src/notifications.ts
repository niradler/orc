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
