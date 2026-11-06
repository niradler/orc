import { z } from "zod";
import { ChannelRouteSchema, ChannelTargetSchema } from "./channels.js";
import { JobActionSchema } from "./job-actions.js";
import { RulePolicySchema } from "./rule-types.js";

const name = z.string().trim().min(1).max(200);
const id = z.string().trim().min(1).max(128);

export const NeedsReentrySchema = z
  .object({
    kind: z.enum(["webhook", "channel", "job_env"]),
    name: z.string(),
    field: z.string(),
    reason: z.string(),
  })
  .strict();
export type NeedsReentry = z.infer<typeof NeedsReentrySchema>;

const CommentSchema = z
  .object({
    resource_type: z.enum(["task", "project", "job", "memory"]),
    resource_id: z.string().min(1).max(200),
    content: z.string().min(1).max(100000),
    author: z.string().min(1).max(200),
    created_at: z.number().int().nonnegative(),
  })
  .strict();

const TaskSchema = z
  .object({
    id,
    title: z.string().min(1).max(500),
    body: z.string().nullable(),
    git_repo: z.string().nullable(),
    git_branch: z.string().nullable(),
    git_worktree: z.string().nullable(),
    github_issue: z.string().nullable(),
    github_pr: z.string().nullable(),
    status: z.enum([
      "todo",
      "queued",
      "doing",
      "review",
      "changes_requested",
      "blocked",
      "done",
      "paused",
      "cancelled",
    ]),
    priority: z.enum(["low", "normal", "high", "critical"]),
    progress: z.number().int(),
    due_at: z.number().int().nullable(),
    tags: z.array(z.string()).nullable(),
    author: z.string(),
    skill_name: z.string().nullable(),
    required_review: z.boolean(),
    agent_backend: z.string().nullable(),
    agent_model: z.string().nullable(),
    max_review_rounds: z.number().int(),
    auto_start: z.boolean(),
    flow_name: z.string().nullable(),
    flow_override: z.unknown().nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();

const LinkSchema = z
  .object({
    from_task_id: id,
    to_task_id: id,
    link_type: z.enum([
      "blocks",
      "blocked_by",
      "relates_to",
      "duplicates",
      "clones",
      "subtask_of",
      "parent_of",
    ]),
  })
  .strict();

const MemorySchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string(),
    content: z.string(),
    priority: z.number().int().nullable(),
  })
  .strict();

const JobSchema = z
  .object({
    id,
    name: z.string().min(1).max(100),
    description: z.string().nullable(),
    command: z.string(),
    action: JobActionSchema.nullable(),
    skill_name: z.string().nullable(),
    prompt_vars: z.record(z.string(), z.string()).nullable(),
    inject_context: z.boolean(),
    trigger_type: z.enum(["one-shot", "cron", "watch", "webhook", "manual", "bridge-msg"]),
    cron_expr: z.string().nullable(),
    watch_path: z.string().nullable(),
    run_at: z.number().int().nullable(),
    timeout_secs: z.number().int(),
    max_retries: z.number().int(),
    overlap: z.enum(["skip", "queue", "kill"]),
    env_vars: z.record(z.string(), z.string()).nullable(),
    working_dir: z.string().nullable(),
    notify_on: z.enum(["never", "failure", "always"]),
    notify_channel: z.string(),
    enabled: z.boolean(),
  })
  .strict();

const WebhookSchema = z
  .object({
    name: z.string().min(1).max(100),
    provider: z.enum(["generic", "github"]),
    events: z.array(z.string()),
    actions: z.array(z.string()),
    enabled: z.boolean(),
    subscriptions: z.array(
      z
        .object({
          job_id: id,
          events: z.array(z.string()),
          actions: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

const FlowSchema = z
  .object({
    name: z.string().min(1).max(100),
    source: z.enum(["user", "project"]),
    definition: z.unknown(),
  })
  .strict();

const ChannelSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    provider: z.enum(["telegram", "slack"]),
    enabled: z.boolean(),
    config: z.record(z.string(), z.unknown()),
    targets: z.array(ChannelTargetSchema),
    routes: z.array(ChannelRouteSchema),
    credential_fields: z.array(z.string()),
  })
  .strict();

const SettingsSchema = z
  .object({
    scope: z.string().nullable(),
    git_remote_url: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    obsidian_path: z.string().nullable(),
    max_workers: z.number().int().nullable(),
    upload_directory: z.string().nullable(),
  })
  .strict();

const ProjectSchema = z
  .object({
    id,
    name,
    description: z.string().nullable(),
    status: z.enum(["active", "archived", "paused"]),
    settings: SettingsSchema,
  })
  .strict();

export const ProjectBundleSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["project", "task"]),
    exported_at: z.string(),
    project: ProjectSchema.nullable(),
    tasks: z.array(TaskSchema),
    comments: z.array(CommentSchema),
    links: z.array(LinkSchema),
    memories: z.array(MemorySchema),
    jobs: z.array(JobSchema),
    webhooks: z.array(WebhookSchema),
    flows: z.array(FlowSchema),
    channels: z.array(ChannelSchema),
    rules: z.array(RulePolicySchema),
    needs_reentry: z.array(NeedsReentrySchema),
  })
  .strict();
export type ProjectBundle = z.infer<typeof ProjectBundleSchema>;

export const IssuedSecretSchema = z
  .object({
    kind: z.literal("webhook"),
    name: z.string(),
    token: z.string(),
    secret: z.string(),
  })
  .strict();

export const ImportResultSchema = z
  .object({
    project_id: z.string().nullable(),
    project_name: z.string().nullable(),
    created_project: z.boolean(),
    counts: z.object({
      tasks: z.number().int(),
      comments: z.number().int(),
      memories: z.number().int(),
      jobs: z.number().int(),
      webhooks: z.number().int(),
      flows: z.number().int(),
      channels: z.number().int(),
      rules: z.number().int(),
      links: z.number().int(),
    }),
    needs_reentry: z.array(NeedsReentrySchema),
    issued: z.array(IssuedSecretSchema),
    skipped: z.array(z.object({ kind: z.string(), name: z.string(), reason: z.string() }).strict()),
  })
  .strict();
export type ImportResult = z.infer<typeof ImportResultSchema>;
