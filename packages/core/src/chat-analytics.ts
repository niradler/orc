import { z } from "zod";
import { SessionCacheUsageSchema } from "./usage";

export const ChatToolStatSchema = z.object({
  name: z.string(),
  calls: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
});
export type ChatToolStat = z.infer<typeof ChatToolStatSchema>;

export const ChatTurnStatSchema = z.object({
  index: z.number().int().positive(),
  startedAt: z.number().finite().nonnegative(),
  durationMs: z.number().finite().nonnegative().nullable(),
  outcome: z.enum(["completed", "stopped", "failed", "running"]),
  toolCalls: z.number().int().nonnegative(),
  toolFailures: z.number().int().nonnegative(),
  responseChars: z.number().int().nonnegative(),
});
export type ChatTurnStat = z.infer<typeof ChatTurnStatSchema>;

export const ChatContextAnalyticsSchema = z.object({
  backend: z.string(),
  model: z.string().nullable(),
  supported: z.boolean(),
  reason: z.string().nullable(),
  usage: SessionCacheUsageSchema,
});
export type ChatContextAnalytics = z.infer<typeof ChatContextAnalyticsSchema>;

export const ChatAnalyticsSchema = z.object({
  messages: z.number().int().nonnegative(),
  userMessages: z.number().int().nonnegative(),
  assistantMessages: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolFailures: z.number().int().nonnegative(),
  attachments: z.number().int().nonnegative(),
  startedAt: z.number().finite().nonnegative().nullable(),
  lastActivityAt: z.number().finite().nonnegative().nullable(),
  outcomes: z.object({
    completed: z.number().int().nonnegative(),
    stopped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
  }),
  durations: z.object({
    averageMs: z.number().finite().nonnegative().nullable(),
    medianMs: z.number().finite().nonnegative().nullable(),
    p95Ms: z.number().finite().nonnegative().nullable(),
    totalMs: z.number().finite().nonnegative().nullable(),
  }),
  tools: z.array(ChatToolStatSchema),
  /** Distinct tools used, before the payload keeps only the most-used ones. */
  toolTotal: z.number().int().nonnegative(),
  turnTimeline: z.array(ChatTurnStatSchema),
  turnTimelineTruncated: z.boolean(),
  context: ChatContextAnalyticsSchema.nullable(),
});
export type ChatAnalytics = z.infer<typeof ChatAnalyticsSchema>;
export type ChatTurnOutcome = ChatTurnStat["outcome"];
