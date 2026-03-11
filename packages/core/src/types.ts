import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "todo",
  "doing",
  "review",
  "changes_requested",
  "blocked",
  "done",
  "cancelled",
]);
export const TaskPrioritySchema = z.enum(["low", "normal", "high", "critical"]);
export const JobTriggerTypeSchema = z.enum([
  "one-shot",
  "cron",
  "repeat",
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
export const BridgePlatformSchema = z.enum(["telegram", "discord", "feishu"]);
export const BridgeModeSchema = z
  .enum(["direct", "agent:claude", "agent:codex"])
  .or(z.string().startsWith("job:"));

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;
export type JobTriggerType = z.infer<typeof JobTriggerTypeSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobOverlap = z.infer<typeof JobOverlapSchema>;
export type MemoryImportance = z.infer<typeof MemoryImportanceSchema>;
export type BridgePlatform = z.infer<typeof BridgePlatformSchema>;
export type BridgeMode = z.infer<typeof BridgeModeSchema>;

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

export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["doing", "cancelled"],
  doing: ["review", "blocked", "cancelled"],
  blocked: ["doing", "cancelled"],
  review: ["done", "changes_requested"],
  changes_requested: ["doing"],
  done: [],
  cancelled: [],
};
