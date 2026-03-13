export type TaskStatus =
  | "todo"
  | "doing"
  | "review"
  | "changes_requested"
  | "blocked"
  | "done"
  | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "critical";
export type TaskType = "feature" | "bug" | "research" | "ops" | "chore" | "coordination";
export type TaskExecutionMode = "solo" | "pair" | "parallel" | "handoff";
export type TaskNoteKind = "comment" | "checkpoint" | "handoff" | "review" | "claim" | "system";
export type TaskLinkType =
  | "blocks"
  | "blocked_by"
  | "relates_to"
  | "duplicates"
  | "clones"
  | "subtask_of"
  | "parent_of";
export type JobTriggerType = "one-shot" | "cron" | "watch" | "webhook" | "manual" | "bridge-msg";
export type JobStatus = "pending" | "running" | "success" | "failed" | "cancelled" | "skipped";
export type JobOverlap = "skip" | "queue" | "kill";

export type Task = {
  id: string;
  project_id: string | null;
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  task_type: TaskType;
  execution_mode: TaskExecutionMode;
  progress: number;
  due_at: string | null;
  tags: string[] | null;
  author: string;
  assigned_to: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  active_branch: string | null;
  acceptance_criteria: string[] | null;
  context_refs: string[] | null;
  next_action: string | null;
  parallel_group: string | null;
  last_checkpoint_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskNote = {
  id: string;
  task_id: string;
  content: string;
  author: string;
  kind: TaskNoteKind;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type Memory = {
  id: string;
  content: string;
  source: string | null;
  scope: string | null;
  tags: string[] | null;
  importance: "low" | "normal" | "high" | "critical";
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Job = {
  id: string;
  name: string;
  description: string | null;
  command: string;
  trigger_type: JobTriggerType;
  cron_expr: string | null;
  enabled: boolean;
  timeout_secs: number;
  max_retries: number;
  overlap: "skip" | "queue" | "kill";
  notify_on: "never" | "failure" | "always";
  run_count: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export type JobRun = {
  id: string;
  job_id: string;
  status: JobStatus;
  trigger_by: string | null;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  error_msg: string | null;
  retry_num: number;
  created_at: string;
};

export type Session = {
  id: string;
  agent: string;
  agent_version: string | null;
  project_id: string | null;
  job_run_id: string | null;
  summary: string | null;
  tokens_used: number | null;
  created_at: string;
};

export type ProjectStatus = "active" | "archived" | "paused";
export type ProjectCoordinationMode = "solo" | "human_agent" | "multi_agent";

export type Project = {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  scope: string | null;
  tags: string[] | null;
  obsidian_path: string | null;
  coordination_mode: ProjectCoordinationMode;
  default_task_execution_mode: TaskExecutionMode;
  working_agreement: string | null;
  shared_context: string | null;
  created_at: string;
  updated_at: string;
};

export type HealthResponse = { status: "ok"; version: string; uptime: number };

export type CreateTaskInput = {
  title: string;
  body?: string;
  project_id?: string;
  status?: "todo" | "doing" | "blocked";
  priority?: TaskPriority;
  task_type?: TaskType;
  execution_mode?: TaskExecutionMode;
  progress?: number;
  due_at?: string;
  tags?: string[];
  author?: string;
  assigned_to?: string;
  active_branch?: string;
  acceptance_criteria?: string[];
  context_refs?: string[];
  next_action?: string;
  parallel_group?: string;
};

export type UpdateTaskInput = {
  title?: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  task_type?: TaskType;
  execution_mode?: TaskExecutionMode;
  progress?: number;
  due_at?: string | null;
  tags?: string[] | null;
  assigned_to?: string | null;
  active_branch?: string | null;
  acceptance_criteria?: string[] | null;
  context_refs?: string[] | null;
  next_action?: string | null;
  parallel_group?: string | null;
};

export type TaskClaimInput = {
  actor: string;
  ttl_minutes?: number;
  branch?: string;
  note?: string;
  force?: boolean;
};

export type TaskCheckpointInput = {
  author?: string;
  summary: string;
  progress?: number;
  status?: "doing" | "blocked" | "review" | "changes_requested";
  next_action?: string;
  context_refs?: string[];
  branch?: string;
  release_claim?: boolean;
};

export type TaskHandoffInput = {
  from_actor: string;
  to_actor: string;
  summary: string;
  progress?: number;
  next_action?: string;
  context_refs?: string[];
  branch?: string;
  force?: boolean;
};

export type CreateMemoryInput = {
  content: string;
  type?: "fact" | "decision" | "event" | "rule" | "discovery";
  source?: string;
  scope?: string;
  tags?: string[];
  importance?: "low" | "normal" | "high" | "critical";
  expires_at?: string;
};

export type CreateJobInput = {
  name: string;
  description?: string;
  command: string;
  trigger_type: JobTriggerType;
  cron_expr?: string;
  watch_path?: string;
  timeout_secs?: number;
  max_retries?: number;
  overlap?: "skip" | "queue" | "kill";
  notify_on?: "never" | "failure" | "always";
  env_vars?: Record<string, string>;
  working_dir?: string;
};

export type Prompt = {
  id: string;
  name: string;
  description: string | null;
  template: string;
  is_skill: boolean;
  skill_dir: string | null;
  skill_version: string | null;
  tags: string[] | null;
  version: number;
  pinned: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CreatePromptInput = {
  name: string;
  description?: string;
  template: string;
  is_skill?: boolean;
  skill_dir?: string;
  skill_version?: string;
  tags?: string[];
  pinned?: boolean;
};

export type UpdatePromptInput = {
  name?: string;
  description?: string;
  template?: string;
  is_skill?: boolean;
  skill_dir?: string;
  skill_version?: string;
  tags?: string[];
  pinned?: boolean;
};

export type RenderedPrompt = {
  rendered: string;
  prompt_id: string;
  version: number;
};

export type PromptHistoryEntry = {
  id: string;
  prompt_id: string;
  version: number;
  name: string;
  description: string | null;
  template: string;
  tags: string[] | null;
  changed_by: string;
  changed_at: string;
};

export type TaskLink = {
  id: string;
  from_task_id: string;
  to_task_id: string;
  link_type: TaskLinkType;
  created_at: string;
};

export type JobRunLog = {
  id: number;
  run_id: string;
  ts: string;
  stream: "stdout" | "stderr";
  line: string;
};

export type CreateTaskLinkInput = {
  to_task_id: string;
  link_type: TaskLinkType;
};

export type CreateProjectInput = {
  name: string;
  description?: string;
  status?: ProjectStatus;
  scope?: string;
  tags?: string[];
  obsidian_path?: string;
  coordination_mode?: ProjectCoordinationMode;
  default_task_execution_mode?: TaskExecutionMode;
  working_agreement?: string;
  shared_context?: string;
};

export type UpdateProjectInput = {
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  scope?: string | null;
  tags?: string[] | null;
  obsidian_path?: string | null;
  coordination_mode?: ProjectCoordinationMode;
  default_task_execution_mode?: TaskExecutionMode;
  working_agreement?: string | null;
  shared_context?: string | null;
};

export type ApiError = { error: string; code: string };

export type ApiResult<T> = { data: T; error: null } | { data: null; error: ApiError };
