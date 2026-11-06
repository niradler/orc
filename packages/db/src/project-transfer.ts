import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelConnection } from "@orc/core/channels";
import { NotFoundError, ValidationError } from "@orc/core/errors";
import { FLOW_NAME_RE, parseFlowDefinition } from "@orc/core/flow";
import { createFlow, readFlow, reloadFlows } from "@orc/core/flow-service";
import { BUILTIN_FLOW_SOURCES } from "@orc/core/flows/builtin";
import { ulid } from "@orc/core/ids";
import type { JobAction } from "@orc/core/job-actions";
import { JobActionSchema } from "@orc/core/job-actions";
import {
  type ImportResult,
  type NeedsReentry,
  type ProjectBundle,
  ProjectBundleSchema,
} from "@orc/core/project-bundle";
import type { RulePolicy } from "@orc/core/rule-types";
import { RulePolicySchema } from "@orc/core/rule-types";
import { encryptSecret } from "@orc/core/secrets";
import { ChannelStore } from "./channels.js";
import { MemoryStore } from "./memories.js";
import { RuleStore } from "./rules.js";

const SECRET_ENV = /(secret|password|passwd|credential|private[-_]?key|api[-_]?key)/i;
const TOKEN_ENV = /(^|[_-])token($|[_-])/i;

type TaskRow = {
  id: string;
  project_id: string | null;
  title: string;
  body: string | null;
  git_repo: string | null;
  git_branch: string | null;
  git_worktree: string | null;
  github_issue: string | null;
  github_pr: string | null;
  status: ProjectBundle["tasks"][number]["status"];
  priority: ProjectBundle["tasks"][number]["priority"];
  progress: number;
  due_at: number | null;
  tags: string | null;
  author: string;
  skill_name: string | null;
  required_review: number;
  agent_backend: string | null;
  agent_model: string | null;
  max_review_rounds: number;
  auto_start: number;
  flow_name: string | null;
  flow_override: string | null;
  created_at: number;
  updated_at: number;
};

type JobRow = {
  id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  command: string;
  action: string | null;
  skill_name: string | null;
  prompt_vars: string | null;
  inject_context: number;
  trigger_type: ProjectBundle["jobs"][number]["trigger_type"];
  cron_expr: string | null;
  watch_path: string | null;
  run_at: number | null;
  timeout_secs: number;
  max_retries: number;
  overlap: ProjectBundle["jobs"][number]["overlap"];
  env_vars: string | null;
  working_dir: string | null;
  notify_on: ProjectBundle["jobs"][number]["notify_on"];
  notify_channel: string;
  enabled: number;
};

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived" | "paused";
  scope: string | null;
  git_remote_url: string | null;
  tags: string | null;
  obsidian_path: string | null;
  max_workers: number | null;
  upload_directory: string | null;
};

function asJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value as T;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function secretEnvKey(key: string): boolean {
  return SECRET_ENV.test(key) || TOKEN_ENV.test(key);
}

function reentry(kind: NeedsReentry["kind"], entryName: string, field: string): NeedsReentry {
  const reason =
    kind === "webhook"
      ? "Excluded from the bundle; enter it again on the destination"
      : kind === "channel"
        ? "Channel credential is excluded and must be entered again on the destination"
        : "Secret environment value is excluded and must be entered again on the destination";
  return { kind, name: entryName, field, reason };
}

function projectById(db: Database, projectId: string): ProjectRow {
  const project = db
    .query<ProjectRow, [string]>("SELECT * FROM projects WHERE id=?")
    .get(projectId);
  if (!project) throw new NotFoundError("Project", projectId);
  return project;
}

function bundleProject(project: ProjectRow): NonNullable<ProjectBundle["project"]> {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    settings: {
      scope: project.scope,
      git_remote_url: project.git_remote_url,
      tags: asJson<string[] | null>(project.tags, null),
      obsidian_path: project.obsidian_path,
      max_workers: project.max_workers,
      upload_directory: project.upload_directory,
    },
  };
}

function taskBundle(row: TaskRow): ProjectBundle["tasks"][number] {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    git_repo: row.git_repo,
    git_branch: row.git_branch,
    git_worktree: row.git_worktree,
    github_issue: row.github_issue,
    github_pr: row.github_pr,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    due_at: row.due_at,
    tags: asJson<string[] | null>(row.tags, null),
    author: row.author,
    skill_name: row.skill_name,
    required_review: Boolean(row.required_review),
    agent_backend: row.agent_backend,
    agent_model: row.agent_model,
    max_review_rounds: row.max_review_rounds,
    auto_start: Boolean(row.auto_start),
    flow_name: row.flow_name,
    flow_override: asJson<unknown>(row.flow_override, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function jobAction(row: JobRow): JobAction | null {
  if (!row.action) return row.command ? { type: "command", command: row.command } : null;
  const parsed = JobActionSchema.safeParse(asJson(row.action, null));
  if (!parsed.success) throw new ValidationError(`Job ${row.name} has an unreadable action`);
  return parsed.data;
}

function redactEnv(
  raw: Record<string, string> | null,
  jobName: string,
  needs: NeedsReentry[],
): Record<string, string> | null {
  if (!raw) return null;
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (secretEnvKey(key)) {
      needs.push(reentry("job_env", jobName, key));
      continue;
    }
    kept[key] = value;
  }
  return kept;
}

function commentsFor(db: Database, where: string, args: string[]): ProjectBundle["comments"] {
  return db
    .query<
      {
        resource_type: ProjectBundle["comments"][number]["resource_type"];
        resource_id: string;
        content: string;
        author: string;
        created_at: number;
      },
      string[]
    >(
      `SELECT resource_type, resource_id, content, author, created_at FROM comments WHERE ${where} ORDER BY created_at, id`,
    )
    .all(...args);
}

function addFlow(
  flows: Map<string, ProjectBundle["flows"][number]>,
  flowName: string | null | undefined,
) {
  if (!flowName || flows.has(flowName)) return;
  const flow = readFlow(flowName);
  if (!flow || flow.source === "builtin") return;
  flows.set(flowName, {
    name: flow.name,
    source: flow.source === "project" ? "project" : "user",
    definition: flow.definition,
  });
}

function flowsOnDisk(scope: string | null, into: Map<string, ProjectBundle["flows"][number]>) {
  if (!scope || !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(scope)) return;
  const dir = join(scope, ".orc", "flows");
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !FLOW_NAME_RE.test(entry.name) || into.has(entry.name)) continue;
    const file = join(dir, entry.name, "flow.json");
    if (!existsSync(file)) continue;
    try {
      into.set(entry.name, {
        name: entry.name,
        source: "project",
        definition: JSON.parse(readFileSync(file, "utf8")) as unknown,
      });
    } catch {
      throw new ValidationError(`Flow ${entry.name} in ${dir} is not valid JSON`);
    }
  }
}

function exportBundle(
  db: Database,
  project: ProjectRow,
  tasks: TaskRow[],
  kind: ProjectBundle["kind"],
): ProjectBundle {
  reloadFlows();
  const needs: NeedsReentry[] = [];
  const taskIds = tasks.map((task) => task.id);
  const comments = [
    ...(kind === "project"
      ? commentsFor(db, "resource_type='project' AND resource_id=?", [project.id])
      : []),
    ...(taskIds.length
      ? commentsFor(
          db,
          `resource_type='task' AND resource_id IN (${taskIds.map(() => "?").join(",")})`,
          taskIds,
        )
      : []),
  ];
  const links = taskIds.length
    ? db
        .query<ProjectBundle["links"][number], string[]>(
          `SELECT from_task_id, to_task_id, link_type FROM task_links
           WHERE from_task_id IN (${taskIds.map(() => "?").join(",")})
              OR to_task_id IN (${taskIds.map(() => "?").join(",")})
           ORDER BY id`,
        )
        .all(...taskIds, ...taskIds)
    : [];
  const flows = new Map<string, ProjectBundle["flows"][number]>();
  for (const task of tasks) {
    addFlow(flows, task.flow_name);
    const override = asJson<{ name?: string } | null>(task.flow_override, null);
    if (override && typeof override === "object" && override.name) addFlow(flows, override.name);
  }

  let memories: ProjectBundle["memories"] = [];
  let jobs: ProjectBundle["jobs"] = [];
  let webhooks: ProjectBundle["webhooks"] = [];
  let channels: ProjectBundle["channels"] = [];
  let rules: ProjectBundle["rules"] = [];
  if (kind === "project") {
    memories = db
      .query<ProjectBundle["memories"][number], [string]>(
        "SELECT name, description, content, priority FROM memories WHERE project_id=? ORDER BY name",
      )
      .all(project.id);
    const memoryNames = memories.map((memory) => memory.name);
    if (memoryNames.length) {
      comments.push(
        ...commentsFor(
          db,
          `resource_type='memory' AND resource_id IN (${memoryNames.map(() => "?").join(",")})`,
          memoryNames,
        ),
      );
    }
    const jobRows = db
      .query<JobRow, [string]>("SELECT * FROM jobs WHERE project_id=? ORDER BY name")
      .all(project.id);
    jobs = jobRows.map((row) => {
      const action = jobAction(row);
      if (action?.type === "task") addFlow(flows, action.flow_name);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        command: action?.type === "command" ? action.command : row.command,
        action,
        skill_name: row.skill_name,
        prompt_vars: asJson<Record<string, string> | null>(row.prompt_vars, null),
        inject_context: Boolean(row.inject_context),
        trigger_type: row.trigger_type,
        cron_expr: row.cron_expr,
        watch_path: row.watch_path,
        run_at: row.run_at,
        timeout_secs: row.timeout_secs,
        max_retries: row.max_retries,
        overlap: row.overlap,
        env_vars: redactEnv(
          asJson<Record<string, string> | null>(row.env_vars, null),
          row.name,
          needs,
        ),
        working_dir: row.working_dir,
        notify_on: row.notify_on,
        notify_channel: row.notify_channel,
        enabled: Boolean(row.enabled),
      };
    });
    const jobIds = jobs.map((job) => job.id);
    if (jobIds.length) {
      comments.push(
        ...commentsFor(
          db,
          `resource_type='job' AND resource_id IN (${jobIds.map(() => "?").join(",")})`,
          jobIds,
        ),
      );
    }
    const hooks = db
      .query<
        {
          name: string;
          provider: "generic" | "github";
          events: string;
          actions: string;
          enabled: number;
          id: string;
        },
        [string]
      >(
        "SELECT id, name, provider, events, actions, enabled FROM webhooks WHERE project_id=? ORDER BY name",
      )
      .all(project.id);
    webhooks = hooks.map((hook) => {
      needs.push(reentry("webhook", hook.name, "secret"));
      needs.push(reentry("webhook", hook.name, "token"));
      const subscriptions = db
        .query<{ job_id: string; events: string; actions: string }, [string]>(
          "SELECT job_id, events, actions FROM webhook_subscriptions WHERE webhook_id=?",
        )
        .all(hook.id)
        .map((subscription) => ({
          job_id: subscription.job_id,
          events: asJson<string[]>(subscription.events, []),
          actions: asJson<string[]>(subscription.actions, []),
        }));
      return {
        name: hook.name,
        provider: hook.provider,
        events: asJson<string[]>(hook.events, []),
        actions: asJson<string[]>(hook.actions, []),
        enabled: Boolean(hook.enabled),
        subscriptions,
      };
    });
    flowsOnDisk(project.scope, flows);
    const store = new ChannelStore(db);
    channels = store
      .connections()
      .filter(
        (channel) =>
          channel.targets.some((target) => target.project_ids.includes(project.id)) ||
          channel.routes.some(
            (route) => route.action.type === "agent" && route.action.project_id === project.id,
          ),
      )
      .map((channel) => {
        const credential_fields = Object.keys(channel.credentials);
        for (const field of credential_fields) needs.push(reentry("channel", channel.name, field));
        return {
          id: channel.id,
          name: channel.name,
          provider: channel.provider,
          enabled: channel.enabled,
          config: channel.config,
          targets: channel.targets,
          routes: channel.routes,
          credential_fields,
        };
      });
    rules = new RuleStore(db)
      .active()
      .flatMap((revision) => (revision.policy?.project_id === project.id ? [revision.policy] : []));
  }

  return ProjectBundleSchema.parse({
    version: 1,
    kind,
    exported_at: new Date().toISOString(),
    project: bundleProject(project),
    tasks: tasks.map(taskBundle),
    comments,
    links,
    memories,
    jobs,
    webhooks,
    flows: [...flows.values()],
    channels,
    rules,
    needs_reentry: needs,
  });
}

export function exportProject(db: Database, project: string): ProjectBundle {
  const row = db
    .query<ProjectRow, [string, string]>("SELECT * FROM projects WHERE id=? OR name=?")
    .get(project, project);
  if (!row) throw new NotFoundError("Project", project);
  const tasks = db
    .query<TaskRow, [string]>("SELECT * FROM tasks WHERE project_id=? ORDER BY created_at, id")
    .all(row.id);
  return exportBundle(db, row, tasks, "project");
}

export function exportTask(db: Database, taskId: string): ProjectBundle {
  const task = db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id=?").get(taskId);
  if (!task) throw new NotFoundError("Task", taskId);
  if (!task.project_id) throw new ValidationError("Task is not in a project");
  return exportBundle(db, projectById(db, task.project_id), [task], "task");
}

function insertComment(
  db: Database,
  comment: ProjectBundle["comments"][number],
  resourceId: string,
): boolean {
  const existing = db
    .query<{ id: string }, [string, string, string, string, number]>(
      "SELECT id FROM comments WHERE resource_type=? AND resource_id=? AND author=? AND content=? AND created_at=?",
    )
    .get(comment.resource_type, resourceId, comment.author, comment.content, comment.created_at);
  if (existing) return false;
  db.query(
    "INSERT INTO comments (id, resource_type, resource_id, content, author, created_at) VALUES (?,?,?,?,?,?)",
  ).run(
    ulid(),
    comment.resource_type,
    resourceId,
    comment.content,
    comment.author,
    comment.created_at,
  );
  return true;
}

function writeProjectFlow(scope: string | null, definition: { name: string }) {
  if (!scope || !existsSync(scope)) return;
  const dir = join(scope, ".orc", "flows", definition.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "flow.json"), `${JSON.stringify(definition, null, 2)}\n`);
}

function emptyResult(needs: NeedsReentry[]): ImportResult {
  return {
    project_id: null,
    project_name: null,
    created_project: false,
    counts: {
      tasks: 0,
      comments: 0,
      memories: 0,
      jobs: 0,
      webhooks: 0,
      flows: 0,
      channels: 0,
      rules: 0,
      links: 0,
    },
    needs_reentry: needs,
    issued: [],
    skipped: [],
  };
}

export function importBundle(
  db: Database,
  raw: unknown,
  hooks?: { onJob?: (job: Record<string, unknown>) => void },
): ImportResult {
  const bundle = ProjectBundleSchema.parse(raw);
  const result = emptyResult(bundle.needs_reentry);
  const project = bundle.project;
  let projectId: string | null = null;
  if (project) {
    const existing = db
      .query<{ id: string }, [string]>("SELECT id FROM projects WHERE name=?")
      .get(project.name);
    if (existing) {
      projectId = existing.id;
      if (bundle.kind === "project") {
        db.query(
          `UPDATE projects SET description=?, status=?, scope=?, git_remote_url=?, tags=?, obsidian_path=?, max_workers=?, upload_directory=?, updated_at=unixepoch() WHERE id=?`,
        ).run(
          project.description,
          project.status,
          project.settings.scope,
          project.settings.git_remote_url,
          project.settings.tags ? JSON.stringify(project.settings.tags) : null,
          project.settings.obsidian_path,
          project.settings.max_workers,
          project.settings.upload_directory,
          projectId,
        );
      }
    } else {
      projectId = ulid();
      db.query(
        `INSERT INTO projects (id, name, description, status, scope, git_remote_url, tags, obsidian_path, max_workers, upload_directory)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        projectId,
        project.name,
        project.description,
        project.status,
        project.settings.scope,
        project.settings.git_remote_url,
        project.settings.tags ? JSON.stringify(project.settings.tags) : null,
        project.settings.obsidian_path,
        project.settings.max_workers,
        project.settings.upload_directory,
      );
      result.created_project = true;
    }
    result.project_id = projectId;
    result.project_name = project.name;
  }

  const taskIds = new Map<string, string>();
  for (const task of bundle.tasks) {
    const owner = db
      .query<{ project_id: string | null }, [string]>("SELECT project_id FROM tasks WHERE id=?")
      .get(task.id);
    let taskId = task.id;
    if (owner && owner.project_id !== projectId) taskId = ulid();
    taskIds.set(task.id, taskId);
    const values = [
      task.title,
      task.body,
      projectId,
      task.git_repo,
      task.git_branch,
      task.git_worktree,
      task.github_issue,
      task.github_pr,
      task.status,
      task.priority,
      task.progress,
      task.due_at,
      task.tags ? JSON.stringify(task.tags) : null,
      task.author,
      task.skill_name,
      task.required_review ? 1 : 0,
      task.agent_backend,
      task.agent_model,
      task.max_review_rounds,
      task.auto_start ? 1 : 0,
      task.flow_name,
      task.flow_override == null ? null : JSON.stringify(task.flow_override),
      task.updated_at,
    ];
    if (owner && taskId === task.id) {
      db.query(
        `UPDATE tasks SET title=?, body=?, project_id=?, git_repo=?, git_branch=?, git_worktree=?, github_issue=?, github_pr=?, status=?, priority=?, progress=?, due_at=?, tags=?, author=?, skill_name=?, required_review=?, agent_backend=?, agent_model=?, max_review_rounds=?, auto_start=?, flow_name=?, flow_override=?, updated_at=? WHERE id=?`,
      ).run(...values, taskId);
    } else if (!owner || taskId !== task.id) {
      db.query(
        `INSERT INTO tasks (title, body, project_id, git_repo, git_branch, git_worktree, github_issue, github_pr, status, priority, progress, due_at, tags, author, skill_name, required_review, agent_backend, agent_model, max_review_rounds, auto_start, flow_name, flow_override, updated_at, id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(...values, taskId, task.created_at);
      result.counts.tasks += 1;
    }
  }

  const jobIds = new Map<string, string>();
  const touchedJobs: string[] = [];
  for (const job of bundle.jobs) {
    if (!projectId) {
      result.skipped.push({ kind: "job", name: job.name, reason: "Bundle has no project" });
      continue;
    }
    const byName = db
      .query<{ id: string; project_id: string | null }, [string]>(
        "SELECT id, project_id FROM jobs WHERE name=?",
      )
      .get(job.name);
    if (byName && byName.project_id !== projectId) {
      result.skipped.push({
        kind: "job",
        name: job.name,
        reason: "A job with this name belongs to another project",
      });
      continue;
    }
    const jobId = byName?.id ?? job.id;
    const taken = db.query<{ id: string }, [string]>("SELECT id FROM jobs WHERE id=?").get(jobId);
    const id = !byName && taken ? ulid() : jobId;
    jobIds.set(job.id, id);
    const action =
      job.action ?? (job.command ? { type: "command" as const, command: job.command } : null);
    const command = action?.type === "command" ? action.command : job.command;
    const fields = [
      job.name,
      job.description,
      command,
      action ? JSON.stringify(action) : null,
      job.skill_name,
      job.prompt_vars ? JSON.stringify(job.prompt_vars) : null,
      job.inject_context ? 1 : 0,
      job.trigger_type,
      job.cron_expr,
      job.watch_path,
      job.run_at,
      job.timeout_secs,
      job.max_retries,
      job.overlap,
      job.env_vars ? JSON.stringify(job.env_vars) : null,
      job.working_dir,
      job.notify_on,
      job.notify_channel,
      job.enabled ? 1 : 0,
      projectId,
    ];
    if (byName) {
      db.query(
        `UPDATE jobs SET name=?, description=?, command=?, action=?, skill_name=?, prompt_vars=?, inject_context=?, trigger_type=?, cron_expr=?, watch_path=?, run_at=?, timeout_secs=?, max_retries=?, overlap=?, env_vars=?, working_dir=?, notify_on=?, notify_channel=?, enabled=?, project_id=?, updated_at=unixepoch() WHERE id=?`,
      ).run(...fields, id);
    } else {
      db.query(
        `INSERT INTO jobs (name, description, command, action, skill_name, prompt_vars, inject_context, trigger_type, cron_expr, watch_path, run_at, timeout_secs, max_retries, overlap, env_vars, working_dir, notify_on, notify_channel, enabled, project_id, id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(...fields, id);
      result.counts.jobs += 1;
    }
    touchedJobs.push(id);
  }

  if (projectId) {
    const memories = new MemoryStore(db);
    for (const memory of bundle.memories) {
      const existing = db
        .query<{ description: string; content: string; priority: number | null }, [string, string]>(
          "SELECT description, content, priority FROM memories WHERE project_id=? AND name=?",
        )
        .get(projectId, memory.name);
      if (!existing) {
        memories.create({
          project_id: projectId,
          name: memory.name,
          description: memory.description,
          content: memory.content,
          priority: memory.priority,
          author: "import",
        });
        result.counts.memories += 1;
      } else if (
        existing.description !== memory.description ||
        existing.content !== memory.content ||
        existing.priority !== memory.priority
      ) {
        memories.update(
          projectId,
          memory.name,
          {
            description: memory.description,
            content: memory.content,
            priority: memory.priority,
          },
          { author: "import", reason: "Imported project bundle" },
        );
        result.counts.memories += 1;
      }
    }
  }

  const remap = (type: ProjectBundle["comments"][number]["resource_type"], resourceId: string) => {
    if (type === "project") return projectId;
    if (type === "task") return taskIds.get(resourceId) ?? null;
    if (type === "job") return jobIds.get(resourceId) ?? null;
    if (type === "memory")
      return bundle.memories.some((memory) => memory.name === resourceId) ? resourceId : null;
    return null;
  };
  for (const comment of bundle.comments) {
    const resourceId = remap(comment.resource_type, comment.resource_id);
    if (!resourceId) {
      result.skipped.push({
        kind: "comment",
        name: comment.resource_id,
        reason: "The comment's resource was not imported",
      });
      continue;
    }
    if (insertComment(db, comment, resourceId)) result.counts.comments += 1;
  }

  for (const link of bundle.links) {
    const present = (taskId: string) =>
      taskIds.get(taskId) ??
      (db.query("SELECT 1 FROM tasks WHERE id=?").get(taskId) ? taskId : null);
    const from = present(link.from_task_id);
    const to = present(link.to_task_id);
    if (!from || !to) {
      result.skipped.push({
        kind: "link",
        name: `${link.from_task_id}->${link.to_task_id}`,
        reason: "One side of the link is not on the destination",
      });
      continue;
    }
    const duplicate = db
      .query<{ id: string }, [string, string, string]>(
        "SELECT id FROM task_links WHERE from_task_id=? AND to_task_id=? AND link_type=?",
      )
      .get(from, to, link.link_type);
    if (duplicate) continue;
    db.query(
      "INSERT INTO task_links (id, from_task_id, to_task_id, link_type) VALUES (?,?,?,?)",
    ).run(ulid(), from, to, link.link_type);
    result.counts.links += 1;
  }

  if (projectId) {
    for (const hook of bundle.webhooks) {
      const existing = db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM webhooks WHERE project_id=? AND name=?",
        )
        .get(projectId, hook.name);
      let webhookId = existing?.id;
      if (!webhookId) {
        const secret = randomBytes(32).toString("base64url");
        const token = randomBytes(18).toString("base64url");
        webhookId = ulid();
        db.query(
          `INSERT INTO webhooks (id, name, provider, project_id, token, secret, events, actions, enabled)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(
          webhookId,
          hook.name,
          hook.provider,
          projectId,
          token,
          encryptSecret(secret),
          JSON.stringify(hook.events),
          JSON.stringify(hook.actions),
          hook.enabled ? 1 : 0,
        );
        result.issued.push({ kind: "webhook", name: hook.name, token, secret });
        result.counts.webhooks += 1;
      }
      for (const subscription of hook.subscriptions) {
        const jobId = jobIds.get(subscription.job_id);
        if (!jobId) {
          result.skipped.push({
            kind: "webhook",
            name: hook.name,
            reason: "Subscription job was not imported",
          });
          continue;
        }
        db.query(
          `INSERT INTO webhook_subscriptions (webhook_id, job_id, events, actions) VALUES (?,?,?,?)
           ON CONFLICT(webhook_id, job_id) DO UPDATE SET events=excluded.events, actions=excluded.actions`,
        ).run(
          webhookId,
          jobId,
          JSON.stringify(subscription.events),
          JSON.stringify(subscription.actions),
        );
      }
    }
  }

  let wroteFlow = false;
  for (const flow of bundle.flows) {
    const parsed = parseFlowDefinition(flow.definition);
    if (!parsed.ok) {
      result.skipped.push({ kind: "flow", name: flow.name, reason: parsed.errors.join("; ") });
      continue;
    }
    const definition = parsed.definition;
    if (definition.name in BUILTIN_FLOW_SOURCES) {
      result.skipped.push({
        kind: "flow",
        name: definition.name,
        reason: "Built-in flow already exists on the destination",
      });
      continue;
    }
    const current = readFlow(definition.name);
    if (current && JSON.stringify(current.definition) === JSON.stringify(definition)) {
      if (flow.source === "project") writeProjectFlow(project?.settings.scope ?? null, definition);
      continue;
    }
    if (current?.source === "builtin") {
      result.skipped.push({
        kind: "flow",
        name: definition.name,
        reason: "Built-in flow already exists on the destination",
      });
      continue;
    }
    try {
      if (!current) createFlow(definition);
      else {
        result.skipped.push({
          kind: "flow",
          name: definition.name,
          reason: "A different flow with this name already exists",
        });
        continue;
      }
      if (flow.source === "project") writeProjectFlow(project?.settings.scope ?? null, definition);
      wroteFlow = true;
      result.counts.flows += 1;
    } catch (error) {
      result.skipped.push({
        kind: "flow",
        name: definition.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (wroteFlow) reloadFlows();

  if (projectId && bundle.project) {
    const sourceProjectId = bundle.project.id;
    const channels = new ChannelStore(db);
    const current = new Map(channels.connections().map((channel) => [channel.id, channel]));
    for (const channel of bundle.channels) {
      const targets = channel.targets.flatMap((target) => {
        if (!target.project_ids.length) return [{ ...target, project_ids: [] as string[] }];
        if (!target.project_ids.includes(sourceProjectId)) return [];
        return [{ ...target, project_ids: [projectId] }];
      });
      const routes = channel.routes.flatMap((route) => {
        if (route.action.type !== "agent") return [route];
        if (route.action.project_id !== sourceProjectId) {
          result.skipped.push({
            kind: "channel",
            name: `${channel.name}/${route.name}`,
            reason: "Route targets a project that was not in the bundle",
          });
          return [];
        }
        return [{ ...route, action: { ...route.action, project_id: projectId } }];
      });
      const existing = current.get(channel.id);
      if (existing) {
        const merged = existing.targets.map((target) => {
          const incoming = targets.find((item) => item.id === target.id);
          if (!incoming) return target;
          return {
            ...target,
            project_ids: [...new Set([...target.project_ids, ...incoming.project_ids])],
          };
        });
        for (const target of targets) {
          if (!merged.some((item) => item.id === target.id)) merged.push(target);
        }
        channels.saveConnection({ ...existing, targets: merged, routes: existing.routes });
        continue;
      }
      const created: ChannelConnection = {
        id: channel.id,
        name: channel.name,
        provider: channel.provider,
        enabled: channel.credential_fields.length > 0 ? false : channel.enabled,
        revision: 0,
        config: channel.config,
        credentials: {},
        targets,
        routes,
      };
      channels.saveConnection(created);
      result.counts.channels += 1;
    }

    const ruleStore = new RuleStore(db);
    for (const policy of bundle.rules) {
      const next = structuredClone(policy) as RulePolicy;
      next.project_id = projectId;
      let ruleReady = true;
      for (const rule of next.rules) {
        if (rule.target.type !== "job") continue;
        const mapped = jobIds.get(rule.target.job_id);
        if (!mapped) {
          result.skipped.push({
            kind: "rule",
            name: rule.id,
            reason: "Rule job was not imported",
          });
          ruleReady = false;
          break;
        }
        rule.target.job_id = mapped;
      }
      if (!ruleReady) continue;
      if (!existsSync(next.workspace)) {
        result.skipped.push({
          kind: "rule",
          name: next.workspace,
          reason: "Workspace directory does not exist on the destination",
        });
        continue;
      }
      const head = ruleStore.history(next.workspace).find((revision) => revision.current);
      if (head?.policy) {
        result.skipped.push({
          kind: "rule",
          name: next.workspace,
          reason: "Workspace already has rules on the destination",
        });
        continue;
      }
      try {
        ruleStore.activate(RulePolicySchema.parse(next), null, "Imported project bundle");
        result.counts.rules += 1;
      } catch (error) {
        result.skipped.push({
          kind: "rule",
          name: next.workspace,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (hooks?.onJob) {
    for (const jobId of touchedJobs) {
      const job = db
        .query<Record<string, unknown>, [string]>("SELECT * FROM jobs WHERE id=?")
        .get(jobId);
      if (job) hooks.onJob(job);
    }
  }
  return result;
}
