import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  created_at: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
};

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["active", "archived", "paused"] })
      .default("active")
      .notNull(),
    scope: text("scope"),
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    obsidian_path: text("obsidian_path"),
    max_workers: integer("max_workers"),
    ...timestamps,
  },
  (t) => [uniqueIndex("projects_name_idx").on(t.name)],
);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  project_id: text("project_id").references(() => projects.id),
  title: text("title").notNull(),
  body: text("body"),
  status: text("status", {
    enum: [
      "todo",
      "queued",
      "doing",
      "review",
      "changes_requested",
      "blocked",
      "done",
      "paused",
      "cancelled",
    ],
  })
    .default("todo")
    .notNull(),
  priority: text("priority", { enum: ["low", "normal", "high", "critical"] })
    .default("normal")
    .notNull(),
  progress: integer("progress").default(0).notNull(),
  due_at: integer("due_at", { mode: "timestamp" }),
  tags: text("tags", { mode: "json" }).$type<string[]>(),
  author: text("author").default("human").notNull(),
  claimed_by: text("claimed_by"),
  claim_expires_at: integer("claim_expires_at", { mode: "timestamp" }),
  skill_name: text("skill_name"),
  required_review: integer("required_review", { mode: "boolean" }).default(true).notNull(),
  agent_backend: text("agent_backend"),
  agent_model: text("agent_model"),
  max_review_rounds: integer("max_review_rounds").default(3).notNull(),
  ...timestamps,
});

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    resource_type: text("resource_type", { enum: ["task", "project", "job", "memory"] }).notNull(),
    resource_id: text("resource_id").notNull(),
    content: text("content").notNull(),
    author: text("author").default("human").notNull(),
    created_at: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("comments_resource_idx").on(t.resource_type, t.resource_id)],
);

export const task_links = sqliteTable(
  "task_links",
  {
    id: text("id").primaryKey(),
    from_task_id: text("from_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    to_task_id: text("to_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    link_type: text("link_type", {
      enum: [
        "blocks",
        "blocked_by",
        "relates_to",
        "duplicates",
        "clones",
        "subtask_of",
        "parent_of",
      ],
    }).notNull(),
    created_at: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("task_links_from_idx").on(t.from_task_id),
    index("task_links_to_idx").on(t.to_task_id),
  ],
);

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  project_id: text("project_id").references(() => projects.id),
  title: text("title"),
  type: text("type", { enum: ["fact", "decision", "event", "rule", "discovery"] })
    .default("fact")
    .notNull(),
  content: text("content").notNull(),
  source: text("source"),
  scope: text("scope"),
  tags: text("tags", { mode: "json" }).$type<string[]>(),
  importance: text("importance", { enum: ["low", "normal", "high", "critical"] })
    .default("normal")
    .notNull(),
  expires_at: integer("expires_at", { mode: "timestamp" }),
  access_count: integer("access_count").notNull().default(0),
  last_accessed_at: integer("last_accessed_at", { mode: "timestamp" }),
  ...timestamps,
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    project_id: text("project_id").references(() => projects.id),
    name: text("name").notNull(),
    description: text("description"),
    command: text("command").notNull(),
    skill_name: text("skill_name"),
    prompt_vars: text("prompt_vars", { mode: "json" }).$type<Record<string, string>>(),
    inject_context: integer("inject_context", { mode: "boolean" }).default(true).notNull(),
    trigger_type: text("trigger_type", {
      enum: ["one-shot", "cron", "watch", "webhook", "manual", "bridge-msg"],
    }).notNull(),
    cron_expr: text("cron_expr"),
    watch_path: text("watch_path"),
    run_at: integer("run_at", { mode: "timestamp" }),
    timeout_secs: integer("timeout_secs").default(300).notNull(),
    max_retries: integer("max_retries").default(0).notNull(),
    overlap: text("overlap", { enum: ["skip", "queue", "kill"] })
      .default("skip")
      .notNull(),
    env_vars: text("env_vars", { mode: "json" }).$type<Record<string, string>>(),
    working_dir: text("working_dir"),
    notify_on: text("notify_on", { enum: ["never", "failure", "always"] })
      .default("failure")
      .notNull(),
    notify_channel: text("notify_channel").default("telegram").notNull(),
    os_installed: integer("os_installed", { mode: "boolean" }).default(false).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    last_run_at: integer("last_run_at", { mode: "timestamp" }),
    next_run_at: integer("next_run_at", { mode: "timestamp" }),
    run_count: integer("run_count").default(0).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("jobs_name_idx").on(t.name)],
);

export const job_runs = sqliteTable(
  "job_runs",
  {
    id: text("id").primaryKey(),
    job_id: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["pending", "running", "success", "failed", "cancelled", "skipped"],
    }).notNull(),
    trigger_by: text("trigger_by"),
    started_at: integer("started_at", { mode: "timestamp" }),
    ended_at: integer("ended_at", { mode: "timestamp" }),
    exit_code: integer("exit_code"),
    stdout: text("stdout"),
    stderr: text("stderr"),
    error_msg: text("error_msg"),
    retry_num: integer("retry_num").default(0).notNull(),
    created_at: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("job_runs_job_id_idx").on(t.job_id)],
);

export const job_run_logs = sqliteTable(
  "job_run_logs",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    run_id: text("run_id")
      .notNull()
      .references(() => job_runs.id, { onDelete: "cascade" }),
    ts: integer("ts", { mode: "timestamp" }).notNull(),
    stream: text("stream", { enum: ["stdout", "stderr"] }).notNull(),
    line: text("line").notNull(),
  },
  (t) => [index("job_run_logs_run_id_idx").on(t.run_id, t.ts)],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  agent: text("agent").notNull(),
  agent_version: text("agent_version"),
  project_id: text("project_id").references(() => projects.id),
  job_run_id: text("job_run_id").references(() => job_runs.id),
  summary: text("summary"),
  events: text("events", { mode: "json" }).$type<unknown[]>(),
  snapshot: text("snapshot"),
  tokens_used: integer("tokens_used"),
  created_at: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const bridge_chats = sqliteTable(
  "bridge_chats",
  {
    id: text("id").primaryKey(),
    platform: text("platform", { enum: ["telegram", "slack", "discord", "feishu"] }).notNull(),
    chat_id: text("chat_id").notNull(),
    username: text("username"),
    display_name: text("display_name"),
    mode: text("mode").default("direct").notNull(),
    authorized: integer("authorized", { mode: "boolean" }).default(false).notNull(),
    session_id: text("session_id"),
    thread_id: text("thread_id"),
    working_dir: text("working_dir"),
    project_id: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    updated_at: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    created_at: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex("bridge_chats_platform_chat_idx").on(t.platform, t.chat_id)],
);

export const bridge_messages = sqliteTable("bridge_messages", {
  id: text("id").primaryKey(),
  chat_id: text("chat_id").references(() => bridge_chats.id),
  direction: text("direction", { enum: ["in", "out"] }).notNull(),
  role: text("role", { enum: ["system", "user", "assistant"] })
    .default("user")
    .notNull(),
  text: text("text"),
  job_run_id: text("job_run_id").references(() => job_runs.id),
  gateway_session_id: text("gateway_session_id").references(() => gateway_sessions.id),
  platform_msg_id: text("platform_msg_id"),
  thread_id: text("thread_id"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  created_at: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const bridge_permissions = sqliteTable("bridge_permissions", {
  id: text("id").primaryKey(),
  chat_id: text("chat_id"),
  gateway_session_id: text("gateway_session_id").references(() => gateway_sessions.id),
  job_run_id: text("job_run_id").references(() => job_runs.id),
  tool: text("tool").notNull(),
  command: text("command"),
  scope: text("scope", { enum: ["once", "session"] })
    .default("once")
    .notNull(),
  message: text("message"),
  status: text("status", { enum: ["pending", "approved", "denied", "expired"] })
    .default("pending")
    .notNull(),
  expires_at: integer("expires_at", { mode: "timestamp" }),
  created_at: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  resolved_at: integer("resolved_at", { mode: "timestamp" }),
});

export const gateway_sessions = sqliteTable(
  "gateway_sessions",
  {
    id: text("id").primaryKey(),
    chat_id: text("chat_id").references(() => bridge_chats.id, { onDelete: "cascade" }),
    backend: text("backend").notNull(),
    mode: text("mode").notNull(),
    runtime_session_id: text("runtime_session_id"),
    cwd: text("cwd"),
    acpx_agent: text("acpx_agent"),
    a2a_url: text("a2a_url"),
    title: text("title"),
    model: text("model"),
    status: text("status", { enum: ["idle", "running", "stopped", "error"] })
      .default("idle")
      .notNull(),
    auto_approve: integer("auto_approve", { mode: "boolean" }).default(false).notNull(),
    permission_mode: text("permission_mode"),
    task_id: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    last_error: text("last_error"),
    role: text("role", { enum: ["main", "worker", "reviewer"] }),
    pid: integer("pid"),
    project_id: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    review_rounds: integer("review_rounds").default(0).notNull(),
    last_activity_at: integer("last_activity_at", { mode: "timestamp" }),
    created_at: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updated_at: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("gateway_sessions_chat_idx").on(t.chat_id, t.updated_at)],
);

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  job_id: text("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  created_at: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const knowledge_collections = sqliteTable("knowledge_collections", {
  name: text("name").primaryKey(),
  project_id: text("project_id").references(() => projects.id),
  ...timestamps,
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type TaskLink = typeof task_links.$inferSelect;
export type NewTaskLink = typeof task_links.$inferInsert;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type MemoryType = "fact" | "decision" | "event" | "rule" | "discovery";
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobRun = typeof job_runs.$inferSelect;
export type JobRunLog = typeof job_run_logs.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type BridgeChat = typeof bridge_chats.$inferSelect;
export type BridgeMessage = typeof bridge_messages.$inferSelect;
export type BridgePermission = typeof bridge_permissions.$inferSelect;
export type GatewaySession = typeof gateway_sessions.$inferSelect;
export type GatewaySessionNew = typeof gateway_sessions.$inferInsert;
export type KnowledgeCollectionRow = typeof knowledge_collections.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
