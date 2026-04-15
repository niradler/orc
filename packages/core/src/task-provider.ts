import type { TaskStatus } from "./types.js";

export type PickedTask = {
  id: string;
  title: string;
  body: string | null;
  status: TaskStatus;
  skill_name: string | null;
  agent_backend: string | null;
  agent_model: string | null;
  tags: string | null;
  project_id: string | null;
};

export type TaskStatusUpdateOpts = {
  taskId: string;
  status: TaskStatus;
  comment?: string;
  author?: string;
  claimedBy?: string;
};

export type TaskStatusUpdateResult = {
  ok: boolean;
  error?: string;
};

export interface TaskProvider {
  pickWorkTasks(): Promise<PickedTask[]>;
  pickReviewTasks(): Promise<PickedTask[]>;
  claimTask(taskId: string, sessionId: string): Promise<void>;
  releaseTask(taskId: string): Promise<void>;
  updateTaskStatus(opts: TaskStatusUpdateOpts): Promise<TaskStatusUpdateResult>;
  addComment(taskId: string, comment: string, author: string): Promise<void>;
  getTask(taskId: string): Promise<PickedTask | null>;
}
