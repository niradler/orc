import { z } from "zod";

/** Browser push services ORC delivers to. Limits server-side requests to known providers. */
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
];
const PUSH_SERVICE_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return (
    PUSH_SERVICE_HOSTS.includes(host) ||
    PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

const base64url = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/, "Expected a base64url key");

export const PushTopicSchema = z.enum(["attention", "chat"]);
export const PUSH_TOPICS = PushTopicSchema.options;

export const PushSubscriptionInputSchema = z
  .object({
    endpoint: z
      .string()
      .max(2048)
      .refine(isPushServiceEndpoint, "Endpoint must be a known browser push service"),
    keys: z.object({ p256dh: base64url, auth: base64url }).strict(),
    label: z.string().trim().min(1).max(120),
    /** Omitted on re-subscribe to keep the device's current choice; new devices get every topic. */
    topics: z.array(PushTopicSchema).max(2).optional(),
  })
  .strict();

export const PushDeviceUpdateSchema = z
  .object({ topics: z.array(PushTopicSchema).max(2) })
  .strict();

export const PushDeviceSchema = z.object({
  id: z.string(),
  label: z.string(),
  endpoint_host: z.string(),
  topics: z.array(PushTopicSchema),
  created_at: z.number(),
  last_success_at: z.number().nullable(),
  failure_count: z.number().int(),
});

export const PushConfigSchema = z.object({ public_key: z.string() });

export const PushMessageSchema = z.object({
  title: z.string().max(200),
  body: z.string().max(500),
  url: z.string().max(2048),
  tag: z.string().max(200),
});

export type PushTopic = z.infer<typeof PushTopicSchema>;
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInputSchema>;
export type PushDeviceUpdate = z.infer<typeof PushDeviceUpdateSchema>;
export type PushDevice = z.infer<typeof PushDeviceSchema>;
export type PushConfig = z.infer<typeof PushConfigSchema>;
export type PushMessage = z.infer<typeof PushMessageSchema>;
