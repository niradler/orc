import { z } from "zod";
import { SessionCacheUsageSchema } from "./usage";

export const ChatUsageSourceSchema = z.enum(["recorded", "estimated", "unreadable"]);
export type ChatUsageSource = z.infer<typeof ChatUsageSourceSchema>;

export const ChatTurnUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type ChatTurnUsage = z.infer<typeof ChatTurnUsageSchema>;

export const ChatToolStatSchema = z.object({
  name: z.string(),
  calls: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
});
export type ChatToolStat = z.infer<typeof ChatToolStatSchema>;

export const ChatSkillStatSchema = z.object({
  name: z.string(),
  loads: z.number().int().positive(),
});
export type ChatSkillStat = z.infer<typeof ChatSkillStatSchema>;

export const ChatTurnStatSchema = z.object({
  index: z.number().int().positive(),
  startedAt: z.number().finite().nonnegative(),
  durationMs: z.number().finite().nonnegative().nullable(),
  outcome: z.enum(["completed", "stopped", "interrupted", "failed", "running"]),
  toolCalls: z.number().int().nonnegative(),
  toolFailures: z.number().int().nonnegative(),
  responseChars: z.number().int().nonnegative(),
  model: z.string().nullable().default(null),
  usage: ChatTurnUsageSchema.nullable().default(null),
  costUsd: z.number().finite().nonnegative().nullable().default(null),
  usageSource: ChatUsageSourceSchema.default("unreadable"),
});
export type ChatTurnStat = z.infer<typeof ChatTurnStatSchema>;

export const ChatModelUsageStatSchema = z.object({
  model: z.string().nullable(),
  turns: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  usage: ChatTurnUsageSchema,
  costUsd: z.number().finite().nonnegative().nullable(),
  cacheHitRate: z.number().finite().min(0).max(1).nullable(),
  cacheSavingsUsd: z.number().finite().nonnegative().nullable(),
  usageSource: ChatUsageSourceSchema,
});
export type ChatModelUsageStat = z.infer<typeof ChatModelUsageStatSchema>;

export const ChatUsageSummarySchema = z.object({
  totals: ChatTurnUsageSchema.nullable(),
  attributed: ChatTurnUsageSchema.nullable(),
  unattributed: ChatTurnUsageSchema.nullable(),
  unattributedRequests: z.number().int().nonnegative(),
  cacheHitRate: z.number().finite().min(0).max(1).nullable(),
  cacheSavingsUsd: z.number().finite().nonnegative().nullable(),
  totalCostUsd: z.number().finite().nonnegative().nullable(),
  costComplete: z.boolean(),
  usageSource: ChatUsageSourceSchema,
  byModel: z.array(ChatModelUsageStatSchema),
});
export type ChatUsageSummary = z.infer<typeof ChatUsageSummarySchema>;

export const EMPTY_CHAT_USAGE_SUMMARY: ChatUsageSummary = {
  totals: null,
  attributed: null,
  unattributed: null,
  unattributedRequests: 0,
  cacheHitRate: null,
  cacheSavingsUsd: null,
  totalCostUsd: null,
  costComplete: false,
  usageSource: "unreadable",
  byModel: [],
};

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
    interrupted: z.number().int().nonnegative(),
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
  skills: z.array(ChatSkillStatSchema),
  turnTimeline: z.array(ChatTurnStatSchema),
  turnTimelineTruncated: z.boolean(),
  usage: ChatUsageSummarySchema.default(EMPTY_CHAT_USAGE_SUMMARY),
  context: ChatContextAnalyticsSchema.nullable(),
});
export type ChatAnalytics = z.infer<typeof ChatAnalyticsSchema>;
export type ChatTurnOutcome = ChatTurnStat["outcome"];
