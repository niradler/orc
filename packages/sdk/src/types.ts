export type TaskStatus =
  | "todo"
  | "queued"
  | "doing"
  | "review"
  | "changes_requested"
  | "blocked"
  | "done"
  | "paused"
  | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "critical";
export type TaskType = "feature" | "bug" | "research" | "ops" | "chore" | "coordination";
export type TaskExecutionMode = "solo" | "pair" | "parallel" | "handoff";
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
  progress: number;
  due_at: string | null;
  tags: string[] | null;
  author: string;
  claimed_by: string | null;
  claim_expires_at: string | null;
  skill_name: string | null;
  required_review: boolean;
  agent_backend: string | null;
  max_review_rounds: number;
  created_at: string;
  updated_at: string;
};

export type Comment = {
  id: string;
  resource_type: "task" | "project" | "job" | "memory";
  resource_id: string;
  content: string;
  author: string;
  created_at: string;
};

export type MemoryType = "fact" | "decision" | "event" | "rule" | "discovery";

export type Memory = {
  id: string;
  project_id: string | null;
  title: string | null;
  type: MemoryType;
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
  project_id: string | null;
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

export type SessionEvent = {
  id: string;
  type: string;
  priority: number;
  data: unknown;
  created_at: string;
};

export type Session = {
  id: string;
  agent: string | null;
  agent_version: string | null;
  project_id: string | null;
  job_run_id: string | null;
  summary: string | null;
  tokens_used: number | null;
  created_at: string;
  updated_at: string;
};

export type SessionDetail = Session & {
  events: SessionEvent[];
  snapshot: string | null;
};

export type ProjectStatus = "active" | "archived" | "paused";
export type Project = {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  scope: string | null;
  tags: string[] | null;
  obsidian_path: string | null;
  max_workers: number | null;
  created_at: string;
  updated_at: string;
};

export type ProjectSummary = {
  project: Project;
  tasks: { total: number; by_status: Record<string, number> };
  memories: number;
  jobs: number;
};

export type HealthResponse = { status: "ok"; version: string; uptime: number };

export type CreateTaskInput = {
  title: string;
  body?: string;
  project_id?: string;
  status?: "todo" | "doing" | "blocked";
  priority?: TaskPriority;
  due_at?: string;
  tags?: string[];
  author?: string;
  skill_name?: string;
  required_review?: boolean;
  agent_backend?: string;
  max_review_rounds?: number;
};

export type UpdateTaskInput = {
  title?: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  progress?: number;
  due_at?: string | null;
  tags?: string[] | null;
  project_id?: string | null;
  skill_name?: string | null;
  required_review?: boolean;
  agent_backend?: string | null;
  max_review_rounds?: number;
  claimed_by?: string | null;
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
  project_id?: string;
  type?: "fact" | "decision" | "event" | "rule" | "discovery";
  source?: string;
  scope?: string;
  tags?: string[];
  importance?: "low" | "normal" | "high" | "critical";
  expires_at?: string;
};

export type UpdateMemoryInput = {
  content?: string;
  title?: string;
  type?: "fact" | "decision" | "event" | "rule" | "discovery";
  source?: string;
  scope?: string;
  tags?: string[];
  importance?: "low" | "normal" | "high" | "critical";
};

export type CreateJobInput = {
  name: string;
  project_id?: string;
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

export type UpdateJobInput = {
  name?: string;
  description?: string;
  command?: string;
  trigger_type?: JobTriggerType;
  cron_expr?: string;
  watch_path?: string;
  timeout_secs?: number;
  max_retries?: number;
  overlap?: "skip" | "queue" | "kill";
  notify_on?: "never" | "failure" | "always";
  enabled?: boolean;
  env_vars?: Record<string, string>;
  working_dir?: string;
  project_id?: string;
};

export type SkillSource = "builtin" | "user";

export type SkillMeta = {
  name: string;
  description: string;
  source: SkillSource;
  path: string;
  metadata: Record<string, unknown>;
};

export type SkillRef = {
  name: string;
  path: string;
};

export type SkillFull = SkillMeta & {
  content: string;
  references: SkillRef[];
};

export type SkillRefContent = {
  name: string;
  path: string;
  content: string;
};

export type CreateSkillInput = {
  name: string;
  content: string;
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
  max_workers?: number;
};

export type UpdateProjectInput = {
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  scope?: string | null;
  tags?: string[] | null;
  obsidian_path?: string | null;
  max_workers?: number | null;
};

export type ApiError = { error: string; code: string };

export type ApiResult<T> = { data: T; error: null } | { data: null; error: ApiError };
