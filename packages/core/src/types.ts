import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "todo",
  "queued",
  "doing",
  "review",
  "changes_requested",
  "blocked",
  "done",
  "paused",
  "cancelled",
]);
export const TaskPrioritySchema = z.enum(["low", "normal", "high", "critical"]);
export const JobTriggerTypeSchema = z.enum([
  "one-shot",
  "cron",
  "watch",
  "webhook",
  "manual",
  "bridge-msg",
]);
export const JobStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "failed",
  "cancelled",
  "skipped",
]);
export const JobOverlapSchema = z.enum(["skip", "queue", "kill"]);
export const MemoryImportanceSchema = z.enum(["low", "normal", "high", "critical"]);
export const BridgePlatformSchema = z.enum(["telegram", "slack", "discord", "feishu"]);
export const BridgeModeSchema = z
  .enum(["direct", "multi"])
  .or(z.string().regex(/^agent:.+/))
  .or(z.string().regex(/^job:.+/));

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;
export type JobTriggerType = z.infer<typeof JobTriggerTypeSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobOverlap = z.infer<typeof JobOverlapSchema>;
export type MemoryImportance = z.infer<typeof MemoryImportanceSchema>;
export type BridgePlatform = z.infer<typeof BridgePlatformSchema>;
export type BridgeMode = z.infer<typeof BridgeModeSchema>;

/** Features ORC can deliver end to end; native support alone is insufficient. */
export const AgentCapabilitiesSchema = z.object({
  version: z.literal(1),
  source: z.enum(["unknown", "adapter", "negotiated"]),
  resume: z.boolean(),
  modelSelection: z.boolean(),
  images: z.boolean(),
  toolOutput: z.boolean(),
  approvals: z.boolean(),
  questions: z.boolean(),
  livePermissions: z.boolean(),
  interrupt: z.boolean(),
  steering: z.boolean(),
  mcp: z.boolean(),
  fork: z.boolean(),
  rollback: z.boolean(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

export const AgentBackendSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);
export type AgentBackendName = z.infer<typeof AgentBackendSchema>;
export type GatewayPlatform = BridgePlatform;
export type GatewayMode = BridgeMode;

export const TaskLinkTypeSchema = z.enum([
  "blocks",
  "blocked_by",
  "relates_to",
  "duplicates",
  "clones",
  "subtask_of",
  "parent_of",
]);
export type TaskLinkType = z.infer<typeof TaskLinkTypeSchema>;

export const ProjectStatusSchema = z.enum(["active", "archived", "paused"]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const TaskExecutionModeSchema = z.enum(["solo", "pair", "parallel", "handoff"]);
export type TaskExecutionMode = z.infer<typeof TaskExecutionModeSchema>;

export const ProjectCoordinationModeSchema = z.enum(["solo", "human_agent", "multi_agent"]);
export type ProjectCoordinationMode = z.infer<typeof ProjectCoordinationModeSchema>;

// Trello-like: any status can transition to any other status.
// Blocker checks (e.g. cannot start a task with unfinished blockers) are enforced
// separately in updateTaskStatus, not via this transition matrix.
const ALL_STATUSES: TaskStatus[] = [
  "todo",
  "queued",
  "doing",
  "review",
  "changes_requested",
  "blocked",
  "done",
  "paused",
  "cancelled",
];
export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = Object.fromEntries(
  ALL_STATUSES.map((from) => [from, ALL_STATUSES.filter((to) => to !== from)]),
) as Record<TaskStatus, TaskStatus[]>;
